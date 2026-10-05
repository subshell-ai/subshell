import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  isSshSessionRef,
  parseSshRuntimeHello,
  parseSshSessionOpenResult,
  SSH_CANCEL_GRACE_MS,
  SSH_PROBE_DEADLINE_MS,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSION_RUNTIME_MISSING,
  SSH_SESSION_UNKNOWN,
  SSH_SESSIONS_PER_NODE,
  type SshConnectionSnapshotWire,
  type SshErrorCode,
  type SshSessionOpenResultWire,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { shellQuote } from "../shell.js";
import { classifySshFailure } from "./ssh-diagnose.js";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "./ssh-render.js";
import { killGroup } from "./ssh-run-child.js";
import { runSshProcess } from "./ssh-spawn.js";

/**
 * The brokered-session engine (design 2026-10-05 §3): one SSH child per
 * session, launched under the SAME mandatory policy the structured runs use
 * (`renderSshConfigContents` unchanged, deny-by-default every hop), pumping
 * the child's stdio as an opaque byte stream to the plane.
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

/** The lifecycle the node-side record keeps (history, never authority: the live map decides). */
type SshSessionLifecycle = "accepted" | "open" | "lost" | "closed";
const LIFECYCLES: readonly string[] = ["accepted", "open", "lost", "closed"];

interface SshSessionRecord {
  ref: string;
  lifecycle: SshSessionLifecycle;
  host: string;
  port: number;
  user: string | null;
  openedAtMs: number;
  lostAtMs?: number;
}

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

/* ------------------------------------------------------------------ */
/* deterministic per-destination tmux socket (design §6 reconciliation) */
/* ------------------------------------------------------------------ */

/**
 * `subshell-ssh-<hash>` for one destination: a second session opened against
 * the same `host:port:user` lands on the same tmux server, which is what makes
 * "the next session finds the first session's panes" work. Hashed (sha1, 12
 * hex, exactly the `tmuxSocketFor` naming rules) because the name rides a
 * `-L` argument and must never embed punctuation; same-input-same-name is the
 * whole reconciliation protocol and is pinned by test.
 */
export function sshSessionTmuxSocket(host: string, port: number, user: string | null): string {
  const hash = createHash("sha1")
    .update(`${host}:${port}:${user ?? ""}`)
    .digest("hex")
    .slice(0, 12);
  return `subshell-ssh-${hash}`;
}

/* ------------------------------------------------------------------ */
/* the snapshot the broker renders (target facts under an unchanged policy) */
/* ------------------------------------------------------------------ */

/**
 * Build the approved snapshot for a session target. The trust refs are the
 * connecting account's OWN default files (design §8: keys and config stay on
 * the connecting node); the auth agent is deliberately excluded - a brokered
 * session is keys-only (§3). ProxyJump is out of the slice's target grammar;
 * the renderer supports it the moment a later workstream widens the target.
 * Returns null when the snapshot grammar refuses the facts (the caller names
 * `config_ambiguous` then; it cannot happen for parsed targets, and the belt
 * is here because this is the last station before a render).
 */
export function sessionTargetSnapshot(target: SshSessionTargetWire, homeDir: string): SshConnectionSnapshotWire {
  return {
    alias: target.alias,
    host: target.host,
    user: target.user,
    port: target.port,
    identityFiles: target.identityFile === null ? [] : [target.identityFile],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: [join(homeDir, ".ssh", "known_hosts"), "/etc/ssh/ssh_known_hosts"],
    hostKeyAlias: null,
    proxyJumps: [],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
  };
}

/* ------------------------------------------------------------------ */
/* hello boundary scan (the broker's ONLY frame awareness)             */
/* ------------------------------------------------------------------ */

/** The hello-boundary outcome: the hello plus the bytes after it, or a named protocol verdict. */
type HelloScan =
  | { kind: "hello"; hello: NonNullable<ReturnType<typeof parseSshRuntimeHello>>; rest: Uint8Array }
  | { kind: "incomplete" }
  /** Well-framed bytes that are NOT a hello, or a prefix too nonsense to be a frame: the stream is speaking something else. */
  | { kind: "protocol" };

/**
 * Scan buffered bytes for the length-prefixed hello frame. This is NOT the
 * codec imported at the ends: it cannot fail-closed a session on a verdict
 * the codec alone owns - but it must recognize the hello boundary, and the
 * ONE thing it treats as terminal (a complete frame that is not a hello, or a
 * lying prefix) is exactly what the codec would also kill. The duplication of
 * the 4-byte read is the price of the broker never importing the runtime
 * grammar beyond the hello, and the codec's own tests pin this same shape.
 */
function scanForHello(buf: Uint8Array): HelloScan {
  for (;;) {
    if (buf.byteLength < 4) return { kind: "incomplete" };
    const declared = new DataView(buf.buffer as ArrayBuffer, buf.byteOffset).getUint32(0, false);
    if (declared === 0 || declared > 262_144) return { kind: "protocol" };
    if (buf.byteLength < 4 + declared) return { kind: "incomplete" };
    const body = buf.subarray(4, 4 + declared);
    const rest = buf.slice(4 + declared);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { kind: "protocol" };
    }
    const hello = parseSshRuntimeHello(parsed);
    if (hello !== null) return { kind: "hello", hello, rest };
    return { kind: "protocol" };
  }
}

/* ------------------------------------------------------------------ */
/* the supervisor                                                      */
/* ------------------------------------------------------------------ */

export class SshSessionSupervisor {
  readonly #dataDir: string;
  readonly #homeDir: string;
  readonly #sshBin: string;
  readonly #nowMs: () => number;
  readonly #live = new Map<string, LiveSession>();
  /** One pending-open chain: quota + acceptance decided together (the run supervisor's reasoning). */
  #openChain: Promise<unknown> = Promise.resolve();

  constructor(deps: SshSessionSupervisorDeps) {
    this.#dataDir = deps.dataDir;
    this.#homeDir = deps.homeDir;
    this.#sshBin = deps.sshBin;
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
    const out: SshSessionRecord[] = [];
    const dir = this.#sessionDir();
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const rec = this.#read(join(dir, name));
      if (rec && (rec.lifecycle === "accepted" || rec.lifecycle === "open") && !this.#live.has(rec.ref)) {
        const lost: SshSessionRecord = { ...rec, lifecycle: "lost", lostAtMs: this.#nowMs() };
        this.#write(lost);
        out.push(lost);
      }
    }
    return out;
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
      const sessionDir = this.#ensureSessionDir();
      const configPath = join(sessionDir, `${req.ref}.config`);
      writeFileSync(configPath, renderSshConfigContents(snapshot), { mode: 0o600 });
      chmodSync(configPath, 0o600);
      this.#write({
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
          cwd: this.#dataDir,
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
      this.#write({
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
        const rec = this.#read(this.#sessionPath(req.ref));
        if (rec && rec.lifecycle !== "closed") this.#write({ ...rec, lifecycle: "lost", lostAtMs: this.#nowMs() });
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
   * panes stay up; killing them is terminate, never a close side effect.
   */
  close(ref: string): "ok" | typeof SSH_SESSION_UNKNOWN {
    const live = this.#live.get(ref);
    if (!live) return SSH_SESSION_UNKNOWN;
    live.stopping = true;
    const rec = this.#read(this.#sessionPath(ref));
    if (rec) this.#write({ ...rec, lifecycle: "closed", lostAtMs: this.#nowMs() });
    killGroup(live.pid, "SIGTERM");
    live.killEscalate = setTimeout(() => {
      killGroup(live.pid, "SIGKILL");
    }, SSH_CANCEL_GRACE_MS);
    live.killEscalate.unref?.();
    return "ok";
  }

  #digest(req: SshSessionOpenRequest): string {
    return createHash("sha256")
      .update(JSON.stringify([req.target, req.runtimeCommand]))
      .digest("hex");
  }

  #sessionDir(): string {
    return join(this.#dataDir, "ssh", "sessions");
  }

  #ensureSessionDir(): string {
    const dir = this.#sessionDir();
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // the dir is inside the agent's own 0700 data dir; a failed tighten is not a leak
    }
    return dir;
  }

  #sessionPath(ref: string): string {
    return join(this.#sessionDir(), `${ref}.json`);
  }

  #read(path: string): SshSessionRecord | null {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (typeof raw.ref !== "string" || typeof raw.lifecycle !== "string") return null;
      if (!LIFECYCLES.includes(raw.lifecycle)) return null;
      if (typeof raw.host !== "string" || typeof raw.port !== "number" || typeof raw.openedAtMs !== "number")
        return null;
      if (!("user" in raw) || !(raw.user === null || typeof raw.user === "string")) return null;
      return {
        ref: raw.ref,
        lifecycle: raw.lifecycle as SshSessionLifecycle,
        host: raw.host,
        port: raw.port,
        user: raw.user as string | null,
        openedAtMs: raw.openedAtMs,
        ...(typeof raw.lostAtMs === "number" ? { lostAtMs: raw.lostAtMs } : {}),
      };
    } catch {
      return null;
    }
  }

  #write(rec: SshSessionRecord): void {
    const dir = this.#ensureSessionDir();
    const path = join(dir, `${rec.ref}.json`);
    writeFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  /** Undo the acceptance for a refusal that never spawned (the crash-between window is the reconcile's, not this path's). */
  #dropRecord(ref: string, configPath: string): void {
    try {
      unlinkSync(this.#sessionPath(ref));
    } catch {
      // nothing recorded means nothing to undo
    }
    try {
      unlinkSync(configPath);
    } catch {
      // as above
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
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
