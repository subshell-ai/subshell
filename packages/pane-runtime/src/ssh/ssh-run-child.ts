import { closeSync, writeSync } from "node:fs";
import {
  SSH_CANCEL_GRACE_MS,
  SSH_RUN_OUTPUT_RETENTION_BYTES,
  type SshConnectionSnapshotWire,
} from "@internal/subshell-protocol";
import { buildSshInvocation, remoteCommandLine, sshChildEnv } from "./ssh-render.js";
import { assertSshRunPath, openRunStreamAppend, readRun, writeRunState } from "./ssh-run-store.js";

/**
 * One supervised ssh child: the spawn mechanics, the output drains, and the
 * bounded-grace stop. Split out of `ssh-run-supervisor.ts` at the seam that
 * matters: THIS file is process-and-pipe mechanics; the supervisor is
 * acceptance, quota, registry, and exit honesty. Neither re-implements the
 * other's promises; the supervisor hands in the finalize hook that turns a
 * raw exit into durable facts.
 */

/** The minimal reader shape the drain needs (structural, like `run-bounded.ts` — the concrete reader class varies by stream generic). */
interface DrainReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
}

/**
 * Signal the child's PROCESS GROUP (it is the group leader: spawned
 * `detached`). ssh leaves children behind on the simplest cancel path (the
 * ProxyJump `-W` grandchildren), and a group signal is the only stop that
 * reaches them; the single-pid kill is the fallback for a child that somehow
 * is not a group leader.
 *
 * Exported for `ssh-session-supervisor.ts`, which leads its session children
 * the same way and must reach the same grandchildren (the session's ssh may
 * ProxyJump; the runtime it spawns on the destination is the SSH child's own
 * remote problem, but the LOCAL group is ours to stop).
 */
export function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // ESRCH / EPERM: no group (or not ours) — fall to the single pid.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already reaped
  }
}

/** Bytes of stderr tail kept in memory for exit classification (bounded; the file holds the rest). */
const STDERR_TAIL_BYTES = 8 * 1024;

/** What the child needs from its owner: the same facts the supervisor was built with. */
export interface SshRunChildDeps {
  dataDir: string;
  homeDir: string;
  sshBin: string;
  nowMs(): number;
}

/** The spawn input: exactly the run's approved material (the digest is the supervisor's business). */
export interface SshRunChildRequest {
  runId: string;
  snapshot: SshConnectionSnapshotWire;
  remoteDir: string | null;
  command: string;
  deadlineMs: number;
}

/** The live half of one run: processes and fds the state file cannot describe. */
export interface SshRunChild {
  proc: Bun.Subprocess;
  /** The child's pid — ALSO its process-group id (spawned `detached`), which is what makes the stop reach ssh's children (the ProxyJump `-W` grandchildren, the auth helpers): a SIGTERM to ssh alone lets an orphan keep the stdout pipe open forever, which would hold the drain, the `exited` gate, and the cancel answer open past any grace. */
  pid: number;
  stdoutFd: number;
  stderrFd: number;
  /** Combined RETAINED bytes across both streams; past the cap the drain discards. */
  retained: number;
  truncated: boolean;
  /** Rolling tail of stderr, only ever read by the exit classifier. */
  stderrTail: Buffer;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  killEscalate?: ReturnType<typeof setTimeout>;
  stopping: boolean;
  /** Releases both stream readers (the last-resort unstick if a survivor outside the killed group still holds the pipe). */
  cancelReaders: () => void;
  /** Resolves when the child has exited AND both drains have stopped. */
  exited: Promise<void>;
}

/**
 * SIGTERM the GROUP now, SIGKILL after {@link SSH_CANCEL_GRACE_MS}, and a
 * last-resort reader cancel on escalation. `stopping` keeps double signals
 * idempotent. The grace ends when the KILL goes out — the SUPERVISOR decides
 * `cancelLocalConfirmed` from whether the exit arrived within it, never from
 * the signal.
 */
export function stopSshRunChild(child: SshRunChild): void {
  if (child.stopping) return;
  child.stopping = true;
  killGroup(child.pid, "SIGTERM");
  child.killEscalate = setTimeout(() => {
    killGroup(child.pid, "SIGKILL");
    // If anything outside the killed group still holds the write ends, the
    // drains would wait on an orphan forever; releasing the readers lets
    // `exited` settle and finalize record what it can see.
    child.cancelReaders();
  }, SSH_CANCEL_GRACE_MS);
  child.killEscalate.unref?.();
}

/**
 * Spawn, drain, and hand the raw exit to `onFinalize`.
 *
 * `onLive` registers the child with its owner (the supervisor's live map)
 * BEFORE any timer or drain starts, so a fast child cannot finalize past a
 * registration that never happened. On a spawn or fd failure the acceptance
 * record reads `unknown` here (the same honest state a crash between accept
 * and spawn produces — never a retry, never a claim about a remote program)
 * and the function resolves `null`.
 */
export async function spawnSshRunChild(
  deps: SshRunChildDeps,
  req: SshRunChildRequest,
  onLive: (child: SshRunChild) => void,
  onFinalize: (child: SshRunChild, exitCode: number | null, exitSignal: string | null) => void,
): Promise<SshRunChild | null> {
  // Every run-dir composition site goes through the store's assert: this
  // module is NOT an exception because it "knows" the id came from accept.
  const dir = assertSshRunPath(deps.dataDir, req.runId);
  const configPath = `${dir}/config`; // written by acceptRun BEFORE this call
  const argv = buildSshInvocation({
    sshBin: deps.sshBin,
    snapshot: req.snapshot,
    configPath,
    remoteCommand: remoteCommandLine(req.command, req.remoteDir),
  });
  const env = await sshChildEnv(req.snapshot, deps.homeDir);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, {
      stdin: "ignore", // a prompt cannot stall a supervised run; BatchMode answers what an ignored stdin cannot
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd: deps.dataDir,
      // own process group: the stop signals the GROUP (see SshRunChild.pid),
      // reaching every ssh helper/grandchild. Without this, the ssh client
      // can outlive TERM or leave helpers holding the pipes.
      detached: true,
    });
  } catch {
    // The child never existed. The record reads `unknown` — the same honest
    // state a crash between accept and spawn produces — NEVER a retry, and
    // NEVER a "failed" claim about a remote program.
    writeUnknown(deps, req.runId);
    return null;
  }
  let stdoutFd: number;
  let stderrFd: number;
  try {
    stdoutFd = openRunStreamAppend(deps.dataDir, req.runId, "stdout");
    stderrFd = openRunStreamAppend(deps.dataDir, req.runId, "stderr");
  } catch {
    // No place to keep output: stop the child before it produces any the
    // store cannot account for; `unknown`, like the spawn-failure branch.
    killGroup(proc.pid, "SIGKILL");
    writeUnknown(deps, req.runId);
    return null;
  }
  const rec = readRun(deps.dataDir, req.runId);
  if (rec)
    writeRunState(deps.dataDir, {
      ...rec.state,
      lifecycle: "running",
      startedAtMs: deps.nowMs(),
      spawned: true,
    });
  // Readers are acquired UP FRONT so the stop path can cancel them: a
  // stream already locked by a running read refuses `stream.cancel()`,
  // only its own reader can release it (the run-bounded.ts lesson).
  const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const child: SshRunChild = {
    proc,
    pid: proc.pid,
    stdoutFd,
    stderrFd,
    retained: 0,
    truncated: false,
    stderrTail: Buffer.alloc(0),
    stopping: false,
    cancelReaders: () => {
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
    },
    exited: Promise.resolve(), // replaced immediately below with the real exit gate
  };
  onLive(child);
  child.deadlineTimer = setTimeout(
    () => {
      // The deadline is a SUPERVISION fact FIRST (recorded even if the stop
      // itself misbehaves), then the same bounded-grace local stop a
      // cancellation uses. It never claims anything about the remote side.
      const current = readRun(deps.dataDir, req.runId);
      if (current && (current.state.lifecycle === "running" || current.state.lifecycle === "accepted")) {
        writeRunState(deps.dataDir, { ...current.state, deadlineHit: true });
      }
      stopSshRunChild(child);
    },
    Math.max(1, req.deadlineMs),
  );
  child.deadlineTimer.unref?.();

  // The drain loops write straight to the store's fds and hold NO line
  // buffer: the "bounded partial-line and in-flight buffers" promise is
  // made structural. Bytes land, or are discarded and counted — nothing
  // accumulates anywhere a stuck consumer could grow.
  const drain = async (reader: DrainReader, fd: number): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const room = SSH_RUN_OUTPUT_RETENTION_BYTES - child.retained;
        if (room <= 0) {
          child.truncated = true; // KEEP draining: a blocked writer never exits
          continue;
        }
        const keep = value.byteLength <= room ? value : value.subarray(0, room);
        try {
          writeSync(fd, keep);
        } catch {
          // the store vanished under a live run (an operator delete racing
          // us): stop retaining, keep draining; honesty comes from
          // `truncated`, and the exit finalize re-reads the record anyway.
          child.truncated = true;
          continue;
        }
        child.retained += keep.byteLength;
        if (keep.byteLength < value.byteLength) child.truncated = true;
        if (fd === stderrFd) {
          const merged = Buffer.concat([child.stderrTail, keep]);
          child.stderrTail =
            merged.byteLength > STDERR_TAIL_BYTES ? merged.subarray(merged.byteLength - STDERR_TAIL_BYTES) : merged;
        }
      }
    } catch {
      // cancelled/errored stream (killed child): fall through to the exit path
    }
  };

  child.exited = (async (): Promise<void> => {
    await Promise.all([drain(stdoutReader, stdoutFd), drain(stderrReader, stderrFd)]);
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    try {
      exitCode = await proc.exited;
      // `signal` is reported by Bun once the child died by signal; the
      // typed surface in this bun version keys it off the generic, so the
      // one-line cast reads the runtime truth (null unless signalled).
      if (exitCode === null) exitSignal = (proc as unknown as { signal?: string | null }).signal ?? null;
    } catch {
      // `exited` never resolved cleanly; the exit facts stay null-null,
      // which is the unknown side, never an invented failure.
    }
    try {
      closeSync(stdoutFd);
    } catch {
      // already closed
    }
    try {
      closeSync(stderrFd);
    } catch {
      // already closed
    }
    if (child.deadlineTimer !== undefined) clearTimeout(child.deadlineTimer);
    if (child.killEscalate !== undefined) clearTimeout(child.killEscalate);
    onFinalize(child, exitCode, exitSignal);
  })();
  child.exited.catch(() => {});
  return child;
}

function writeUnknown(deps: SshRunChildDeps, runId: string): void {
  const rec = readRun(deps.dataDir, runId);
  if (rec) {
    writeRunState(deps.dataDir, { ...rec.state, lifecycle: "unknown", finishedAtMs: deps.nowMs() });
  }
}
