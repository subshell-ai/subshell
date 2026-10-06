import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSshSessionOpenResult,
  SSH_PROBE_DEADLINE_MS,
  SSH_RUNTIME_SERVE_IN_USE_EXIT,
  SSH_SESSION_IN_USE,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSION_RUNTIME_MISSING,
  type SshErrorCode,
  type SshSessionOpenResultWire,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { shellQuote } from "../shell.js";
import { killGroup } from "./kill-group.js";
import { classifySshFailure } from "./ssh-diagnose.js";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "./ssh-render.js";
import {
  concatBytes,
  type HelloScan,
  safeUsername,
  scanForHello,
  sessionTargetSnapshot,
  sshSessionTmuxSocket,
} from "./ssh-session-invocation.js";
import type { SshSessionRecordStore } from "./ssh-session-store.js";
import { runSshProcess } from "./ssh-spawn.js";

/**
 * The open-spawn/hello-pump sequence of one brokered session (design
 * 2026-10-05 §3): durable acceptance, the runtime probe, the child spawn, the
 * hello gate, and the pumps that outlive the open. The supervisor
 * (`ssh-session-supervisor.ts`) owns the surface - ref grammar, dedup, quota,
 * the send/close door, boot reconcile, and the live map this file registers
 * into; this file owns the ONE path that takes a request to a live child,
 * in the order that order is load-bearing:
 *
 * - **Probe before spawn**: `command -v <runtime>` over the same rendered
 *   policy; an absent runtime answers `runtime_missing` with guidance for the
 *   BINARY only (design §7 - never enrollment, never `subshell setup`).
 * - **Durable acceptance before spawn**: the state file lands first, so a
 *   crash between acceptance and spawn reads back `lost`, never a ghost open.
 * - **Hello gates the open**: the child must produce a parsed hello within
 *   {@link SSH_SESSION_OPEN_DEADLINE_MS} or the open fails and the group is
 *   killed. A half-open session is never reported as open.
 * - **Opaque pump**: stdout bytes AFTER the hello are forwarded through the
 *   transport hooks without interpretation; stderr streams diagnostic lines;
 *   the child's exit closes the record and reports the loss once.
 * - **Kill the GROUP** at agent exit: the spawn arms the process-exit hook
 *   that SIGKILLs every tracked pid (design §3: "at agent exit the child goes
 *   with it").
 *
 * Refusals the plane maps by EQUALITY ride the bare codes: `runtime_missing`,
 * `session_in_use`, `session_protocol`, `connection_failed` and the classified
 * transport codes.
 * `run_unknown` (bad ref), `run_conflict` (digest mismatch) and
 * `session_quota` are decided by the supervisor BEFORE this function runs.
 */

/** The transport's side of the pump, wired by the agent's executor (the WS is not this file's business). */
export interface SshSessionHooks {
  /** Forward pumped stdout bytes (post-hello) to the plane. Awaiting is the transport's backpressure beat. */
  emitBytes(chunk: Uint8Array): Promise<void>;
  /** Forward one stderr line (diagnostics text only). */
  emitDiag(line: string): void;
  /**
   * Report the child's unexpected death once (`ssh_session_lost` upstream).
   * Not called for an explicit supervisor `close`, and not called before the
   * open answered (the refusal already carried the fact).
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
export interface LiveSession {
  pid: number;
  stdin: { write(data: Uint8Array): unknown; flushAsync?(): Promise<unknown> };
  result: SshSessionOpenResultWire;
  requestDigest: string;
  stopping: boolean;
  killEscalate?: ReturnType<typeof setTimeout>;
}

/** The supervisor facts the open flow drives; the live map receives the child on success. */
export interface SshSessionOpenDriver {
  homeDir: string;
  sshBin: string;
  store: SshSessionRecordStore;
  nowMs: () => number;
  live: Map<string, LiveSession>;
  /** The dedup digest for this request (the supervisor owns the rule; the live entry carries it). */
  requestDigest: string;
}

/** Process-level live pids, group-killed on `exit` (design §3's agent-exit promise; `exit` is sync-safe). */
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

/** Undo the acceptance for a refusal that never spawned (the crash-between window is the reconcile's, not this path's). */
function dropRecord(store: SshSessionRecordStore, ref: string, configPath: string): void {
  store.drop(ref);
  try {
    unlinkSync(configPath);
  } catch {
    // the rendered config is transient; the ssh retention sweep owns strays
  }
}

/**
 * Take one accepted open request to a live child: acceptance record, probe,
 * spawn, hello gate, pumps (see the module doc for the order and what each
 * promises). The caller has already decided grammar, dedup, and quota; a
 * success registers the child in `drv.live` and the pumps keep it updated
 * there for the child's whole life.
 */
export async function runSessionOpen(
  drv: SshSessionOpenDriver,
  req: SshSessionOpenRequest,
  hooks: SshSessionHooks,
): Promise<SshSessionOpenOutcome> {
  const snapshot = sessionTargetSnapshot(req.target, drv.homeDir);
  const sessionDir = drv.store.ensureDir();
  const configPath = join(sessionDir, `${req.ref}.config`);
  writeFileSync(configPath, renderSshConfigContents(snapshot), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  drv.store.write({
    ref: req.ref,
    lifecycle: "accepted",
    host: req.target.host,
    port: req.target.port,
    user: req.target.user,
    openedAtMs: drv.nowMs(),
  });
  const env = await sshChildEnv(snapshot, drv.homeDir);

  // (1) Runtime probe over the same rendered policy, binary facts only.
  const probe = await runSshProcess(
    buildSshInvocation({
      sshBin: drv.sshBin,
      snapshot,
      configPath,
      remoteCommand: `command -v ${shellQuote(req.runtimeCommand)}`,
    }),
    env,
    SSH_PROBE_DEADLINE_MS,
  );
  const probeAnswered = probe.code === 0 && probe.stdout.trimStart().startsWith("/") && probe.stdout.trim() !== "";
  if (!probeAnswered) {
    dropRecord(drv.store, req.ref, configPath);
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
  // entry point; the justification for the token riding it is in the
  // supervisor's header).
  const socket = sshSessionTmuxSocket(req.target.host, req.target.port, req.target.user);
  const serveLine = remoteCommandLine(
    `${shellQuote(req.runtimeCommand)} runtime-serve --session ${shellQuote(req.ref)} --tmux-socket ${shellQuote(socket)}`,
    null,
  );
  const argv = buildSshInvocation({ sshBin: drv.sshBin, snapshot, configPath, remoteCommand: serveLine });
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd: drv.store.dir(),
      detached: true, // own group: the stop reaches ssh's helper children (killGroup)
    });
  } catch {
    dropRecord(drv.store, req.ref, configPath);
    return { kind: "refused", code: "connection_failed" };
  }
  armExitHook();
  exitTracked.add(proc.pid);
  const stdin = proc.stdin as unknown as LiveSession["stdin"];
  const openStartedAt = drv.nowMs();

  // (3) The hello gate. Read until the hello boundary, the child dying, or
  // the deadline. Death before hello maps by ssh's own exit posture:
  // the serve's own busy exit = the destination already carries a live
  // session (m2 - the binary demonstrably EXISTS, it is running that
  // session), 127 ("command not found" past the probe - a login-shell PATH
  // drift, honest either way), 255/signal = transport, anything else (or a
  // protocol verdict) = the named refusal it is.
  const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const exitedEarly = proc.exited.then((code) => ({ code: code as number | null })).catch(() => ({ code: null }));
  let scan: HelloScan = { kind: "incomplete" };
  let buf: Uint8Array = new Uint8Array(0);
  let deadlineHit = false;
  while (scan.kind === "incomplete") {
    const remaining = SSH_SESSION_OPEN_DEADLINE_MS - (drv.nowMs() - openStartedAt);
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
    dropRecord(drv.store, req.ref, configPath);
    if (scan.kind === "protocol") return { kind: "refused", code: "session_protocol" };
    if (deadlineHit) return { kind: "refused", code: "connection_failed" };
    // The child is gone before hello: ask it how. The serve's busy exit goes
    // FIRST (review m2): a destination with a live session answers it, and
    // the default arm below would dress that up as "binary missing" - the
    // wrong remedy on a machine whose binary is running the other session.
    const early = await exitedEarly;
    if (early.code === SSH_RUNTIME_SERVE_IN_USE_EXIT) return { kind: "refused", code: SSH_SESSION_IN_USE };
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
    dropRecord(drv.store, req.ref, configPath);
    return { kind: "refused", code: "connection_failed" };
  }
  drv.store.write({
    ref: req.ref,
    lifecycle: "open",
    host: req.target.host,
    port: req.target.port,
    user: req.target.user,
    openedAtMs: drv.nowMs(),
  });
  const live: LiveSession = {
    pid: proc.pid,
    stdin,
    result: validated,
    requestDigest: drv.requestDigest,
    stopping: false,
  };
  drv.live.set(req.ref, live);

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
    drv.live.delete(req.ref);
    const rec = drv.store.read(drv.store.path(req.ref));
    if (rec && rec.lifecycle !== "closed") drv.store.write({ ...rec, lifecycle: "lost", lostAtMs: drv.nowMs() });
    try {
      unlinkSync(configPath);
    } catch {
      // as above: transient bytes
    }
    if (!wasStopping) hooks.onLost({ exitCode, signal });
  })();

  return { kind: "open", result: validated };
}
