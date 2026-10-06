import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSshSessionRef,
  parseSshSessionOpenResult,
  SSH_CANCEL_GRACE_MS,
  SSH_PROBE_DEADLINE_MS,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSION_RUNTIME_MISSING,
  SSH_SESSION_UNKNOWN,
  SSH_SESSIONS_PER_NODE,
  type SshErrorCode,
  type SshSessionOpenResultWire,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { shellQuote } from "../shell.js";
import { classifySshFailure } from "./ssh-diagnose.js";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "./ssh-render.js";
import { killGroup } from "./ssh-run-child.js";
import {
  concatBytes,
  type HelloScan,
  safeUsername,
  scanForHello,
  sessionTargetSnapshot,
  sshSessionTmuxSocket,
} from "./ssh-session-invocation.js";
import { digestSessionRequest, type SshSessionRecord, SshSessionRecordStore } from "./ssh-session-store.js";
import { runSshProcess } from "./ssh-spawn.js";

/**
 * The brokered-session engine (design 2026-10-05 §3): one SSH child per
 * session, launched under the SAME mandatory policy the structured runs use
 * (`renderSshConfigContents` unchanged, deny-by-default every hop), pumping
 * the child's stdio as an opaque byte stream to the plane.
 *
 * The file is the CHILD half of the supervisor; the DISK half is
 * `ssh-session-store.ts` (records, boot reconcile scan) and the per-destination
 * facts are `ssh-session-invocation.ts` (socket naming, snapshot, hello scan) -
 * the run family's store/supervisor split, mirrored.
 *
 * Why the node owner running this is NOT a widening: the node's OS user can
 * already run any command on the destination through their own SSH - that is
 * what owning an account on the connecting node means. This supervisor composes
 * exactly one such command (the runtime's own entry point, per-token quoted),
 * under the un-weakened runtime policy, and pipes its stdio.
 *
 * The promises, shaped from the run supervisor's:
 *
 * - **Probe before spawn**: `command -v <runtime>` over the same rendered
 *   policy; an absent runtime answers `runtime_missing` with guidance for the
 *   BINARY only (design §7 - never enrollment, never `subshell setup`).
 * - **Hello gates the open**: the child must produce a parsed hello within
 *   {@link SSH_SESSION_OPEN_DEADLINE_MS} or the open fails and the group is
 *   killed. A half-open session is never reported as open.
 * - **Opaque pump**: stdout bytes AFTER the hello (whose facts answer the
 *   open) are forwarded to the transport without interpretation - the plane
 *   and the runtime own the frames inside; a broker that parsed them would be
 *   a third decoder to drift. Chunk boundaries are boundaries; the ends'
 *   codec reassembles.
 * - **stderr is diagnostics**: text lines forwarded, never interpreted.
 * - **Kill the GROUP** on close (SIGTERM, {@link SSH_CANCEL_GRACE_MS},
 *   SIGKILL), on a failed hello (immediately), and at agent exit (design §3:
 *   "at agent exit the child goes with it").
 * - **Boot reconcile**: a state file claiming `accepted`/`open` with no live
 *   child under this process reads back `lost`, never a restart. The tmux
 *   server the last session spoke to SURVIVED on the destination (design §6);
 *   this record only tells the truth about the child that did not.
 * - **Durable acceptance + dedup**: the state file lands before the spawn,
 *   and a duplicate open of the SAME request re-answers the live result - no
 *   second child; a different payload under one ref answers `run_conflict`.
 *
 * Refusals the plane maps by EQUALITY ride the bare codes: `runtime_missing`,
 * `session_quota`, `session_protocol`, `run_conflict`, `connection_failed`
 * and the classified transport codes; `SSH_SESSION_UNKNOWN` answers send/close
 * on a ref this process has no live child for.
 */

/** Everything the supervisor needs from its host, plus the transport's pump seam. */
export interface SshSessionSupervisorDeps {
  /** Node data dir; session records live under `<dataDir>/ssh/sessions/`. */
  dataDir: string;
  /** The connecting account's home (the ssh child's HOME, the default trust refs). */
  homeDir: string;
  /** Absolute ssh binary (the ladder resolved it; nothing here re-searches). */
  sshBin: string;
  /** Epoch-ms clock (injectable). */
  nowMs(): number;
}

/** The transport's side of the pump, wired by the agent's executor (the WS is not this file's business). */
export interface SshSessionHooks {
  /** Forward pumped stdout bytes (post-hello) to the plane. Awaiting is the transport's backpressure beat. */
  emitBytes(chunk: Uint8Array): Promise<void>;
  /** Forward one stderr line (diagnostics text only). */
  emitDiag(line: string): void;
  /**
   * Report the child's unexpected death once (`ssh_session_lost` upstream).
   * Not called for an explicit {@link SshSessionSupervisor.close}, and not
   * called before the open answered (the refusal already carried the fact).
   */
  onLost(info: { exitCode: number | null; signal: string | null }): void;
}

/** One open request; every fact arrives already parsed from the wire. */
export interface SshSessionOpenRequest {
  ref: string;
  target: SshSessionTargetWire;
  /** Default applied at the command layer; never empty (the parser refuses one). */
  runtimeCommand: string;
}

/** Open outcomes: the parsed hello + destination facts, or a named refusal. */
export type SshSessionOpenOutcome =
  | { kind: "open"; result: SshSessionOpenResultWire }
  | { kind: "refused"; code: SshErrorCode };

/** The live half of one session: child, dedup facts, and the stop latch. */
interface LiveSession {
  pid: number;
  stdin: { write(data: Uint8Array): unknown; flushAsync?(): Promise<unknown> };
  result: SshSessionOpenResultWire;
  requestDigest: string;
  stopping: boolean;
  killEscalate?: ReturnType<typeof setTimeout>;
}

/** Process-wide live pids, group-killed on `exit` (design §3's agent-exit promise; `exit` is sync-safe). */
const exitTracked = new Set<number>();
let exitHookArmed = false;
function armExitHook(): void {
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.on("exit", () => {
    for (const pid of exitTracked) {
      try {
        killGroup(pid, "SIGKILL");
      } catch {
        // nothing more a dying process can do
      }
    }
  });
}

export class SshSessionSupervisor {
  readonly #homeDir: string;
  readonly #sshBin: string;
  readonly #store: SshSessionRecordStore;
  readonly #nowMs: () => number;
  readonly #live = new Map<string, LiveSession>();
  /** One pending-open chain: quota + acceptance decided together (the run supervisor's reasoning). */
  #openChain: Promise<unknown> = Promise.resolve();

  constructor(deps: SshSessionSupervisorDeps) {
    this.#homeDir = deps.homeDir;
    this.#sshBin = deps.sshBin;
    this.#store = new SshSessionRecordStore({ dataDir: deps.dataDir, nowMs: deps.nowMs });
    this.#nowMs = deps.nowMs;
    // Boot reconcile at BUILD time: the first open in this process is what
    // reads last daemon's stale `accepted`/`open` records back to `lost`
    // (never a restart, never a claim about the destination's tmux). Records
    // from a node that never brokers stay untouched, which is fine: they are
    // read only through this map.
    this.reconcileAtBoot();
  }

  /** Live session refs this process supervises right now (the boot reconcile's "mine" set). */
  liveRefs(): string[] {
    return [...this.#live.keys()];
  }

  /** Every `accepted`/`open` state with no live child under this process becomes `lost` (never a restart, never a claim about the destination's tmux). */
  reconcileAtBoot(): SshSessionRecord[] {
    return this.#store.reconcileAll(new Set(this.#live.keys()));
  }

  /**
   * Open one session. Order is the contract: ref grammar -> dedup/quota ->
   * DURABLE ACCEPTANCE -> runtime probe -> spawn -> hello. Every refusal
   * happens before a long-lived child exists; every acceptance before any
   * spawn, so a crash between the two reads back `lost` at the next boot.
   */
  async open(req: SshSessionOpenRequest, hooks: SshSessionHooks): Promise<SshSessionOpenOutcome> {
    const run = async (): Promise<SshSessionOpenOutcome> => {
      if (!isSshSessionRef(req.ref)) return { kind: "refused", code: "run_unknown" };
      const existing = this.#live.get(req.ref);
      if (existing) {
        if (existing.requestDigest === this.#digest(req)) return { kind: "open", result: existing.result };
        return { kind: "refused", code: "run_conflict" };
      }
      if (this.#live.size >= SSH_SESSIONS_PER_NODE) return { kind: "refused", code: "session_quota" };

      const snapshot = sessionTargetSnapshot(req.target, this.#homeDir);
      const sessionDir = this.#store.ensureDir();
      const configPath = join(sessionDir, `${req.ref}.config`);
      writeFileSync(configPath, renderSshConfigContents(snapshot), { mode: 0o600 });
      chmodSync(configPath, 0o600);
      this.#store.write({
        ref: req.ref,
        lifecycle: "accepted",
        host: req.target.host,
        port: req.target.port,
        user: req.target.user,
        openedAtMs: this.#nowMs(),
      });
      const env = await sshChildEnv(snapshot, this.#homeDir);

      // (1) Runtime probe over the same rendered policy, binary facts only.
      const probe = await runSshProcess(
        buildSshInvocation({
          sshBin: this.#sshBin,
          snapshot,
          configPath,
          remoteCommand: `command -v ${shellQuote(req.runtimeCommand)}`,
        }),
        env,
        SSH_PROBE_DEADLINE_MS,
      );
      const probeAnswered = probe.code === 0 && probe.stdout.trimStart().startsWith("/") && probe.stdout.trim() !== "";
      if (!probeAnswered) {
        this.#dropRecord(req.ref, configPath);
        if (probe.timedOut || probe.spawnError) return { kind: "refused", code: "connection_failed" };
        // Exit 1 from `command -v` is the named absence; a 255 (or a null
        // from a signal) may be the transport refusing, which the classifier
        // names; anything else the probe answered without printing an
        // absolute path is as absent as absence.
        if (probe.code === 1) return { kind: "refused", code: SSH_SESSION_RUNTIME_MISSING };
        if (probe.code === 255 || probe.code === null) {
          return { kind: "refused", code: classifySshFailure(probe.stderr) ?? "connection_failed" };
        }
        return { kind: "refused", code: "connection_failed" };
      }

      // (2) Spawn the long-lived child. NO -tt: a destination PTY would echo
      // and rewrite the protocol bytes; stdout must be protocol-only (design
      // §2), which a pipe guarantees and a tty cannot. The remote command is
      // one program invocation with per-token quoting (the slice's runtime
      // entry point; the justification for the token riding it is this file's
      // header).
      const socket = sshSessionTmuxSocket(req.target.host, req.target.port, req.target.user);
      const serveLine = remoteCommandLine(
        `${shellQuote(req.runtimeCommand)} runtime-serve --session ${shellQuote(req.ref)} --tmux-socket ${shellQuote(socket)}`,
        null,
      );
      const argv = buildSshInvocation({ sshBin: this.#sshBin, snapshot, configPath, remoteCommand: serveLine });
      let proc: Bun.Subprocess;
      try {
        proc = Bun.spawn(argv, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
          cwd: this.#store.dir(),
          detached: true, // own group: the stop reaches ssh's helper children (killGroup)
        });
      } catch {
        this.#dropRecord(req.ref, configPath);
        return { kind: "refused", code: "connection_failed" };
      }
      armExitHook();
      exitTracked.add(proc.pid);
      const stdin = proc.stdin as unknown as LiveSession["stdin"];
      const openStartedAt = this.#nowMs();

      // (3) The hello gate. Read until the hello boundary, the child dying, or
      // the deadline. Death before hello maps by ssh's own exit posture:
      // 127 ("command not found" past the probe - a login-shell PATH drift,
      // honest either way), 255/signal = transport, anything else (or a
      // protocol verdict) = the named refusal it is.
      const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const exitedEarly = proc.exited.then((code) => ({ code: code as number | null })).catch(() => ({ code: null }));
      let scan: HelloScan = { kind: "incomplete" };
      let buf: Uint8Array = new Uint8Array(0);
      let deadlineHit = false;
      while (scan.kind === "incomplete") {
        const remaining = SSH_SESSION_OPEN_DEADLINE_MS - (this.#nowMs() - openStartedAt);
        const raced = await Promise.race([
          stdoutReader.read().then((r) => ({ kind: "read" as const, r })),
          exitedEarly.then((e) => ({ kind: "child" as const, e })),
          new Promise<{ kind: "deadline" }>((resolve) => {
            const t = setTimeout(() => resolve({ kind: "deadline" }), Math.max(1, remaining));
            t.unref?.();
          }),
        ]);
        if (raced.kind === "deadline") {
          deadlineHit = true;
          break;
        }
        if (raced.kind === "child") break; // hello never came; classify below
        const r = raced.r;
        if (r.done === true) break; // stdout closed without a hello
        if (r.value !== undefined) {
          buf = concatBytes(buf, r.value);
          scan = scanForHello(buf);
          if (scan.kind === "hello") buf = scan.rest;
        }
      }
      if (scan.kind !== "hello") {
        killGroup(proc.pid, "SIGKILL");
        void stdoutReader.cancel().catch(() => {});
        exitTracked.delete(proc.pid);
        this.#dropRecord(req.ref, configPath);
        if (scan.kind === "protocol") return { kind: "refused", code: "session_protocol" };
        if (deadlineHit) return { kind: "refused", code: "connection_failed" };
        // The child is gone before hello: ask it how.
        const early = await exitedEarly;
        if (early.code === 127) return { kind: "refused", code: SSH_SESSION_RUNTIME_MISSING };
        if (early.code === 255 || early.code === null) {
          return { kind: "refused", code: classifySshFailure("") ?? "connection_failed" };
        }
        return { kind: "refused", code: SSH_SESSION_RUNTIME_MISSING };
      }

      const built: SshSessionOpenResultWire = {
        hello: scan.hello,
        host: req.target.host,
        port: req.target.port,
        user: req.target.user,
        ...(safeUsername() !== undefined ? { connectingAccount: safeUsername() } : {}),
      };
      const validated = parseSshSessionOpenResult(built);
      if (validated === null) {
        killGroup(proc.pid, "SIGKILL");
        exitTracked.delete(proc.pid);
        this.#dropRecord(req.ref, configPath);
        return { kind: "refused", code: "connection_failed" };
      }
      this.#store.write({
        ref: req.ref,
        lifecycle: "open",
        host: req.target.host,
        port: req.target.port,
        user: req.target.user,
        openedAtMs: this.#nowMs(),
      });
      const live: LiveSession = {
        pid: proc.pid,
        stdin,
        result: validated,
        requestDigest: this.#digest(req),
        stopping: false,
      };
      this.#live.set(req.ref, live);

      // (4) The pumps, from the hello boundary onward. stdout forwards raw
      // bytes through the transport hook (whose await IS the backpressure);
      // stderr streams text lines; the exit closes the record.
      const heldAfterHello = scan.rest.byteLength > 0 ? scan.rest : null;
      void (async (): Promise<void> => {
        try {
          if (heldAfterHello !== null) await hooks.emitBytes(heldAfterHello);
          for (;;) {
            const { done, value } = await stdoutReader.read();
            if (done) break;
            if (value !== undefined) await hooks.emitBytes(value);
          }
        } catch {
          // stream broke; the exit branch carries the loss fact
        }
      })();
      void (async (): Promise<void> => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let tail = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            tail += decoder.decode(value, { stream: true });
            let nl = tail.indexOf("\n");
            while (nl >= 0) {
              const line = tail.slice(0, nl).trimEnd();
              tail = tail.slice(nl + 1);
              if (line !== "") hooks.emitDiag(line);
              nl = tail.indexOf("\n");
            }
          }
        } catch {
          // diagnostics are best-effort by definition
        }
      })();
      void (async (): Promise<void> => {
        let exitCode: number | null = null;
        let signal: string | null = null;
        try {
          exitCode = await proc.exited;
          if (exitCode === null) signal = (proc as unknown as { signal?: string | null }).signal ?? null;
        } catch {
          // unobservable: the honest nulls
        }
        exitTracked.delete(proc.pid);
        if (live.killEscalate !== undefined) clearTimeout(live.killEscalate);
        const wasStopping = live.stopping;
        this.#live.delete(req.ref);
        const rec = this.#store.read(this.#store.path(req.ref));
        if (rec && rec.lifecycle !== "closed")
          this.#store.write({ ...rec, lifecycle: "lost", lostAtMs: this.#nowMs() });
        try {
          unlinkSync(configPath);
        } catch {
          // the rendered config is transient; the ssh retention sweep owns strays
        }
        if (!wasStopping) hooks.onLost({ exitCode, signal });
      })();

      return { kind: "open", result: validated };
    };
    const chained = this.#openChain.then(run, run);
    this.#openChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return await chained;
  }

  /**
   * Feed plane->runtime bytes into the child's stdin. Unknown refs answer the
   * bare {@link SSH_SESSION_UNKNOWN}: the plane already learned the loss from
   * the close report; a write to a dead child must never read as a retry cue.
   */
  send(ref: string, bytes: Uint8Array): "ok" | typeof SSH_SESSION_UNKNOWN {
    if (!isSshSessionRef(ref)) return SSH_SESSION_UNKNOWN;
    const live = this.#live.get(ref);
    if (!live) return SSH_SESSION_UNKNOWN;
    try {
      live.stdin.write(bytes);
      void Promise.resolve(live.stdin.flushAsync?.()).catch(() => {});
      return "ok";
    } catch {
      return SSH_SESSION_UNKNOWN;
    }
  }

  /**
   * Close one session as a USER act (design §6's Close): SIGTERM the group,
   * SIGKILL after the grace, record `closed` so the death on the way down is
   * not additionally reported as `lost`. The destination's tmux server and its
   * panes stay up; killing them is terminate, never a close side effect. The
   * plane sends this command on every user close (and the protocol-mismatch
   * unroll); the group-kill promise is not delegated to the runtime's own
   * good behavior.
   */
  close(ref: string): "ok" | typeof SSH_SESSION_UNKNOWN {
    const live = this.#live.get(ref);
    if (!live) return SSH_SESSION_UNKNOWN;
    live.stopping = true;
    const rec = this.#store.read(this.#store.path(ref));
    if (rec) this.#store.write({ ...rec, lifecycle: "closed", lostAtMs: this.#nowMs() });
    killGroup(live.pid, "SIGTERM");
    live.killEscalate = setTimeout(() => {
      killGroup(live.pid, "SIGKILL");
    }, SSH_CANCEL_GRACE_MS);
    live.killEscalate.unref?.();
    return "ok";
  }

  #digest(req: SshSessionOpenRequest): string {
    return digestSessionRequest(req.target, req.runtimeCommand);
  }

  /** Undo the acceptance for a refusal that never spawned (the crash-between window is the reconcile's, not this path's). */
  #dropRecord(ref: string, configPath: string): void {
    this.#store.drop(ref);
    try {
      unlinkSync(configPath);
    } catch {
      // as above
    }
  }
}

/** Process-level registry: one supervisor per data dir (the run supervisor's singleton posture). */
const supervisors = new Map<string, SshSessionSupervisor>();

/** The supervisor for one data dir, built lazily from caller-supplied facts (never at import). */
export function getSshSessionSupervisor(deps: {
  dataDir: string;
  homeDir: string;
  sshBin: string;
  nowMs?: () => number;
}): SshSessionSupervisor {
  let instance = supervisors.get(deps.dataDir);
  if (!instance) {
    instance = new SshSessionSupervisor({ ...deps, nowMs: deps.nowMs ?? Date.now });
    supervisors.set(deps.dataDir, instance);
  }
  return instance;
}

/** The live supervisor for a data dir, if one was ever built (reconcile/sweeps reach through this; NEVER builds one). */
export function peekSshSessionSupervisor(dataDir: string): SshSessionSupervisor | undefined {
  return supervisors.get(dataDir);
}

/** Drop the registry (test isolation). @internal */
export function resetSshSessionSupervisorsForTests(): void {
  supervisors.clear();
}
