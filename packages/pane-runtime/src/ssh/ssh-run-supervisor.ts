import { closeSync, writeSync } from "node:fs";
import {
  type NodeSshRunReadResult,
  SSH_ACTIVE_RUNS_PER_NODE,
  SSH_AGGREGATE_OUTPUT_STORAGE_BYTES,
  SSH_CANCEL_GRACE_MS,
  SSH_READ_LONG_POLL_MAX_MS,
  SSH_RUN_OUTPUT_RETENTION_BYTES,
  type SshConnectionSnapshotWire,
  type SshErrorCode,
  type SshRunFactsWire,
} from "@internal/subshell-protocol";
import { sshTransportFailure } from "./ssh-diagnose.js";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "./ssh-render.js";
import { reconcileUnsupervisedRuns } from "./ssh-retention.js";
import {
  acceptRun,
  buildRunFacts,
  evictCompletedOutput,
  listRunIds,
  openRunStreamAppend,
  readRun,
  readRunStreamWindow,
  runStreamSize,
  type SshRunState,
  sshRunsStorageBytes,
  writeRunState,
} from "./ssh-run-store.js";

/**
 * The supervised structured-run engine (SSH-SUPPORT.md §3: "Each command uses
 * a supervised non-PTY SSH process and independent shell context").
 *
 * One class instance per data dir, held in a process-level registry (the
 * `getAuth` singleton posture): the daemon's `ssh_run_*` executors and the
 * server-hosted node's in-process twin reach the SAME live-process table by
 * data dir, so dedup, quotas, and cancellation see one truth.
 *
 * What the supervisor promises:
 *
 * - **Acceptance before spawn** (durable, in `ssh-run-store`): the RPC
 *   returns as soon as the record lands and the child keeps running in the
 *   background — a long task is never held inside an RPC deadline.
 * - **Bounded output, kept separate**: stdout and stderr stream to their own
 *   files; past {@link SSH_RUN_OUTPUT_RETENTION_BYTES} COMBINED the reader
 *   KEEPS DRAINING and discards (a child blocked on a full, unread pipe never
 *   exits, which would turn a size limit into a hang), and the read answer
 *   reports `truncated` rather than lying about the totals.
 * - **Exit honesty**: a status in [0,254] can only arrive over an established
 *   transport, so it is a confirmed remote result; a bare 255 corroborated by
 *   ssh's own failure lines is ssh's failure (no remote status); an
 *   uncorroborated 255 is the ambiguity itself — `unknown` carrying 255,
 *   `remoteStatusConfirmed: false`, never dressed as success or failure
 *   (man.openbsd.org/ssh#EXIT_STATUS).
 * - **Cancel = bounded-grace LOCAL kill**: SIGTERM,
 *   {@link SSH_CANCEL_GRACE_MS} of grace, SIGKILL; `cancelLocalConfirmed`
 *   says exactly what was observed, and remote descendants are never claimed
 *   to have died.
 * - **No automatic retry, ever**: a spawn failure or a crash between accept
 *   and spawn reads back `unknown` and stays there.
 */

/** How long the read long-poll sleeps between growth checks. */
const READ_POLL_MS = 150;

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
 */
function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
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

/** One spawn request; everything except the digest arrives already parsed from the wire. */
export interface SshSupervisedRunRequest {
  runId: string;
  requestDigest: string;
  snapshot: SshConnectionSnapshotWire;
  remoteDir: string | null;
  command: string;
  deadlineMs: number;
}

/** Start outcomes: a facts envelope, or a named refusal the plane maps by equality. */
export type SshRunStartOutcome = { kind: "facts"; facts: SshRunFactsWire } | { kind: "refused"; code: SshErrorCode };

/** The live half of one run: processes and fds the state file cannot describe. */
interface LiveRun {
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

export class SshRunSupervisor {
  readonly #dataDir: string;
  readonly #homeDir: string;
  readonly #nowMs: () => number;
  readonly #sshBin: string;
  readonly #live = new Map<string, LiveRun>();
  /**
   * One pending-start chain. The quota count and the acceptance are decided
   * together, so a second concurrent start cannot slip between the count and
   * the durable record (16 total means 16, not 16-plus-whatever-raced).
   */
  #startChain: Promise<unknown> = Promise.resolve();

  constructor(deps: { dataDir: string; homeDir: string; sshBin: string; nowMs?: () => number }) {
    this.#dataDir = deps.dataDir;
    this.#homeDir = deps.homeDir;
    this.#sshBin = deps.sshBin;
    this.#nowMs = deps.nowMs ?? Date.now;
  }

  /** Live run ids this process supervises right now (the boot reconcile's "mine" set). */
  liveRunIds(): string[] {
    return [...this.#live.keys()];
  }

  /**
   * Start one run. The order is the contract: per-node active quota →
   * storage pressure (evict-completed-first, then refuse) → DURABLE
   * ACCEPTANCE → spawn. Every refusal happens before any spawn; every
   * acceptance happens before any spawn.
   */
  async start(req: SshSupervisedRunRequest): Promise<SshRunStartOutcome> {
    const run = async (): Promise<SshRunStartOutcome> => {
      if (this.#activeCount() >= SSH_ACTIVE_RUNS_PER_NODE) return { kind: "refused", code: "quota_runs" };
      const usage = sshRunsStorageBytes(this.#dataDir);
      if (usage >= SSH_AGGREGATE_OUTPUT_STORAGE_BYTES) {
        evictCompletedOutput(this.#dataDir, usage - SSH_AGGREGATE_OUTPUT_STORAGE_BYTES + 1, this.#nowMs());
        if (sshRunsStorageBytes(this.#dataDir) >= SSH_AGGREGATE_OUTPUT_STORAGE_BYTES) {
          return { kind: "refused", code: "storage_full" };
        }
      }
      const configText = renderSshConfigContents(req.snapshot);
      const accepted = acceptRun(
        this.#dataDir,
        {
          runId: req.runId,
          requestDigest: req.requestDigest,
          command: req.command,
          remoteDir: req.remoteDir,
          deadlineMs: req.deadlineMs,
          snapshotConfigText: configText,
        },
        this.#nowMs(),
      );
      if (accepted.kind === "conflict") return { kind: "refused", code: "run_conflict" };
      if (accepted.kind === "duplicate") {
        // Duplicate delivery returns EXISTING state: no second spawn, no
        // second acceptance; the facts reflect whatever the original has
        // already become (it may be long completed).
        return { kind: "facts", facts: buildRunFacts(accepted.state) };
      }
      await this.#spawn(req);
      const rec = readRun(this.#dataDir, req.runId);
      // The record exists by construction (acceptRun just wrote it); the
      // fallback is for a subtree deleted between accept and answer — the
      // honest answer then is a fresh `accepted`, not a crash.
      return {
        kind: "facts",
        facts: buildRunFacts(
          rec?.state ?? {
            runId: req.runId,
            lifecycle: "accepted",
            cancelRequested: false,
            cancelLocalConfirmed: false,
            deadlineHit: false,
            remoteStatus: null,
            remoteStatusConfirmed: false,
            localExitCode: null,
            localExitSignal: null,
            startedAtMs: null,
            finishedAtMs: null,
            outputEvicted: false,
            spawned: false,
          },
        ),
      };
    };
    const chained = this.#startChain.then(run, run);
    // The chain itself never rejects, or one failed start would poison every
    // queued one behind it (the same reasoning as the tmux input chain).
    this.#startChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return await chained;
  }

  /** Runs the node holds active: every `accepted`/`running` state on disk (the live map is the spawned subset). */
  #activeCount(): number {
    let n = 0;
    for (const id of listRunIds(this.#dataDir)) {
      const rec = readRun(this.#dataDir, id);
      if (!rec) continue;
      if (rec.state.lifecycle === "accepted" || rec.state.lifecycle === "running") n += 1;
    }
    return n;
  }

  async #spawn(req: SshSupervisedRunRequest): Promise<void> {
    const dir = `${this.#dataDir}/ssh/runs/${req.runId}`;
    const configPath = `${dir}/config`; // written by acceptRun BEFORE this call
    const argv = buildSshInvocation({
      sshBin: this.#sshBin,
      snapshot: req.snapshot,
      configPath,
      remoteCommand: remoteCommandLine(req.command, req.remoteDir),
    });
    const env = await sshChildEnv(req.snapshot, this.#homeDir);
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(argv, {
        stdin: "ignore", // a prompt cannot stall a supervised run; BatchMode answers what an ignored stdin cannot
        stdout: "pipe",
        stderr: "pipe",
        env,
        cwd: this.#dataDir,
        // own process group: the stop signals the GROUP (see LiveRun.pid),
        // reaching every ssh helper/grandchild. Without this, the ssh client
        // can outlive TERM or leave helpers holding the pipes.
        detached: true,
      });
    } catch {
      // The child never existed. The record reads `unknown` — the same honest
      // state a crash between accept and spawn produces — NEVER a retry, and
      // NEVER a "failed" claim about a remote program.
      this.#writeUnknownOnFailure(req.runId);
      return;
    }
    let stdoutFd: number;
    let stderrFd: number;
    try {
      stdoutFd = openRunStreamAppend(this.#dataDir, req.runId, "stdout");
      stderrFd = openRunStreamAppend(this.#dataDir, req.runId, "stderr");
    } catch {
      // No place to keep output: stop the child before it produces any the
      // store cannot account for; `unknown`, like the spawn-failure branch.
      killGroup(proc.pid, "SIGKILL");
      this.#writeUnknownOnFailure(req.runId);
      return;
    }
    const rec = readRun(this.#dataDir, req.runId);
    if (rec)
      writeRunState(this.#dataDir, { ...rec.state, lifecycle: "running", startedAtMs: this.#nowMs(), spawned: true });
    // Readers are acquired UP FRONT so the stop path can cancel them: a
    // stream already locked by a running read refuses `stream.cancel()`,
    // only its own reader can release it (the run-bounded.ts lesson).
    const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const live: LiveRun = {
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
    this.#live.set(req.runId, live);
    live.deadlineTimer = setTimeout(
      () => {
        // The deadline is a SUPERVISION fact FIRST (recorded even if the stop
        // itself misbehaves), then the same bounded-grace local stop a
        // cancellation uses. It never claims anything about the remote side.
        const current = readRun(this.#dataDir, req.runId);
        if (current && (current.state.lifecycle === "running" || current.state.lifecycle === "accepted")) {
          writeRunState(this.#dataDir, { ...current.state, deadlineHit: true });
        }
        this.#stopLive(live);
      },
      Math.max(1, req.deadlineMs),
    );
    live.deadlineTimer.unref?.();

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
          const room = SSH_RUN_OUTPUT_RETENTION_BYTES - live.retained;
          if (room <= 0) {
            live.truncated = true; // KEEP draining: a blocked writer never exits
            continue;
          }
          const keep = value.byteLength <= room ? value : value.subarray(0, room);
          try {
            writeSync(fd, keep);
          } catch {
            // the store vanished under a live run (an operator delete racing
            // us): stop retaining, keep draining; honesty comes from
            // `truncated`, and the exit finalize re-reads the record anyway.
            live.truncated = true;
            continue;
          }
          live.retained += keep.byteLength;
          if (keep.byteLength < value.byteLength) live.truncated = true;
          if (fd === stderrFd) {
            const merged = Buffer.concat([live.stderrTail, keep]);
            live.stderrTail =
              merged.byteLength > STDERR_TAIL_BYTES ? merged.subarray(merged.byteLength - STDERR_TAIL_BYTES) : merged;
          }
        }
      } catch {
        // cancelled/errored stream (killed child): fall through to the exit path
      }
    };

    live.exited = (async (): Promise<void> => {
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
      if (live.deadlineTimer !== undefined) clearTimeout(live.deadlineTimer);
      if (live.killEscalate !== undefined) clearTimeout(live.killEscalate);
      this.#finalize(req.runId, live, exitCode, exitSignal);
    })();
    live.exited.catch(() => {});
  }

  #writeUnknownOnFailure(runId: string): void {
    const rec = readRun(this.#dataDir, runId);
    if (rec) {
      writeRunState(this.#dataDir, {
        ...rec.state,
        lifecycle: "unknown",
        finishedAtMs: this.#nowMs(),
      });
    }
  }

  /** Write the terminal state from the exit facts. Exit-255 honesty lives HERE (see module doc). */
  #finalize(runId: string, live: LiveRun, exitCode: number | null, exitSignal: string | null): void {
    this.#live.delete(runId);
    const rec = readRun(this.#dataDir, runId);
    if (!rec) return; // the subtree vanished under a live run; nothing left to finalize
    const state: SshRunState = { ...rec.state };
    state.localExitCode = exitCode;
    state.localExitSignal = exitSignal;
    state.outputTruncated = live.truncated;
    state.finishedAtMs = this.#nowMs();
    if (exitCode !== null && exitCode !== 255) {
      // A status in [0,254] can only arrive over an ESTABLISHED transport —
      // ssh reserves 255 for its own failures — so it is a confirmed remote
      // status. This asymmetry is the entire basis of the 255 rule.
      state.lifecycle = "completed";
      state.remoteStatus = exitCode;
      state.remoteStatusConfirmed = true;
    } else if (exitCode === 255) {
      if (sshTransportFailure(live.stderrTail.toString("utf8"))) {
        // ssh's own failure is corroborated: NOTHING ran remotely, so there is
        // no remote status to carry (and NO license to call it a remote
        // failure — the local facts say what failed).
        state.lifecycle = "completed";
        state.remoteStatus = null;
        state.remoteStatusConfirmed = false;
      } else {
        // The bare number: transport error or remote exit 255,
        // indistinguishable. `unknown` is the honest lifecycle, and 255 is
        // the ONLY status the facts grammar lets `unknown` carry.
        state.lifecycle = "unknown";
        state.remoteStatus = 255;
        state.remoteStatusConfirmed = false;
      }
    } else {
      // signalled or unobservable: if WE signalled it, the cancel/deadline
      // fact already rides on the record and the LOCAL outcome is known;
      // anything else that killed ssh leaves the remote outcome unknown.
      state.lifecycle = state.cancelRequested || state.deadlineHit ? "completed" : "unknown";
      state.remoteStatus = null;
      state.remoteStatusConfirmed = false;
    }
    writeRunState(this.#dataDir, state);
  }

  /**
   * SIGTERM the GROUP now, SIGKILL after the grace, and a last-resort reader
   * cancel on escalation. `stopping` keeps double signals idempotent. The
   * grace ends when the KILL goes out — `cancelLocalConfirmed` is decided by
   * whether the exit arrived within it, never assumed from the signal.
   */
  #stopLive(live: LiveRun): void {
    if (live.stopping) return;
    live.stopping = true;
    killGroup(live.pid, "SIGTERM");
    live.killEscalate = setTimeout(() => {
      killGroup(live.pid, "SIGKILL");
      // If anything outside the killed group still holds the write ends, the
      // drains would wait on an orphan forever; releasing the readers lets
      // `exited` settle and finalize record what it can see.
      live.cancelReaders();
    }, SSH_CANCEL_GRACE_MS);
    live.killEscalate.unref?.();
  }

  /** Current facts for one id — `null` is the store's `run_unknown` verdict (an unknown id is never a start). */
  status(runId: string): SshRunFactsWire | null {
    const rec = readRun(this.#dataDir, runId);
    return rec ? buildRunFacts(rec.state) : null;
  }

  /**
   * A bounded incremental read, optionally long-polled (`waitMs`, already
   * parser-capped at {@link SSH_READ_LONG_POLL_MAX_MS}). A timed-out wait
   * answers an empty window WITH current facts; nothing here keeps reader
   * state across commands, and a browser closing mid-poll cancels nothing.
   */
  async read(
    runId: string,
    stdoutFromByte: number,
    stderrFromByte: number,
    maxBytes: number,
    waitMs: number,
  ): Promise<NodeSshRunReadResult | null> {
    let rec = readRun(this.#dataDir, runId);
    if (!rec) return null;
    const deadline = Date.now() + Math.min(Math.max(0, waitMs), SSH_READ_LONG_POLL_MAX_MS);
    for (;;) {
      const stdout = readRunStreamWindow(this.#dataDir, runId, "stdout", stdoutFromByte, maxBytes);
      const stderrBudget = Math.max(0, maxBytes - stdout.bytes.byteLength);
      const stderr = readRunStreamWindow(this.#dataDir, runId, "stderr", stderrFromByte, stderrBudget);
      const fresh = stdout.bytes.byteLength > 0 || stderr.bytes.byteLength > 0;
      const terminal = rec.state.lifecycle === "completed" || rec.state.lifecycle === "unknown";
      if (fresh || terminal || Date.now() >= deadline) {
        const live = this.#live.get(runId);
        return {
          ...buildRunFacts(rec.state),
          stdoutB64: stdout.bytes.toString("base64"),
          stderrB64: stderr.bytes.toString("base64"),
          stdoutNext: stdoutFromByte + stdout.bytes.byteLength,
          stderrNext: stderrFromByte + stderr.bytes.byteLength,
          stdoutTotal: runStreamSize(this.#dataDir, runId, "stdout"),
          stderrTotal: runStreamSize(this.#dataDir, runId, "stderr"),
          truncated:
            rec.state.outputTruncated === true || rec.state.outputEvicted === true || (live?.truncated ?? false),
        };
      }
      await Bun.sleep(READ_POLL_MS);
      rec = readRun(this.#dataDir, runId) ?? rec;
    }
  }

  /**
   * Request cancellation: records the fact, stops the LOCAL supervised
   * processes within the grace, and answers once with the post-stop facts.
   * `null` is the store's `run_unknown`; a finished run answers its final
   * facts. Remote descendants: never confirmed, by contract, here and
   * everywhere.
   */
  async cancel(runId: string): Promise<SshRunFactsWire | null> {
    const rec = readRun(this.#dataDir, runId);
    if (!rec) return null;
    writeRunState(this.#dataDir, { ...rec.state, cancelRequested: true });
    const live = this.#live.get(runId);
    if (!live) {
      // Nothing under THIS process's supervision: either finished (the state
      // says so) or an orphan this daemon can neither see nor lawfully kill
      // (a pid it does not own — pid reuse makes boot-time re-kill roulette).
      return this.status(runId);
    }
    this.#stopLive(live);
    const graceExpired = await Promise.race([
      live.exited.then(() => false),
      Bun.sleep(SSH_CANCEL_GRACE_MS + 250).then(() => true),
    ]);
    const after = readRun(this.#dataDir, runId);
    if (!after) return this.status(runId);
    const state: SshRunState = { ...after.state, cancelRequested: true };
    if (!graceExpired) state.cancelLocalConfirmed = true;
    writeRunState(this.#dataDir, state);
    return buildRunFacts(state);
  }

  /**
   * Boot reconciliation (one place for the "reconcile known IDs after
   * reconnect" and crash-between-accept-and-spawn rules): every state
   * claiming `accepted`/`running` that this process has no supervised child
   * for reads back `unknown`. Never a restart, never a retry, never a claim
   * about what the orphan may have done remotely. An orphaned child's stdout
   * pipe has only this dead daemon's absent reader to face, so it wedges
   * within one pipe buffer instead of growing unbounded — the honest bound
   * for a process this daemon never sees born.
   */
  reconcileAtBoot(): SshRunFactsWire[] {
    return reconcileUnsupervisedRuns(this.#dataDir, new Set(this.#live.keys()), this.#nowMs());
  }
}

/** Process-level registry: one supervisor per data dir (the singleton-factory posture). */
const supervisors = new Map<string, SshRunSupervisor>();

/** The supervisor for one data dir, built lazily from caller-supplied facts (never at import). */
export function getSshRunSupervisor(deps: {
  dataDir: string;
  homeDir: string;
  sshBin: string;
  nowMs?: () => number;
}): SshRunSupervisor {
  let instance = supervisors.get(deps.dataDir);
  if (!instance) {
    instance = new SshRunSupervisor(deps);
    supervisors.set(deps.dataDir, instance);
  }
  return instance;
}

/** The live supervisor for a data dir, if one was ever built (the hourly sweep reads its live ids through this; NEVER builds one). */
export function peekSshRunSupervisor(dataDir: string): SshRunSupervisor | undefined {
  return supervisors.get(dataDir);
}

/** Drop the registry (test isolation). @internal */
export function resetSshSupervisorsForTests(): void {
  supervisors.clear();
}
