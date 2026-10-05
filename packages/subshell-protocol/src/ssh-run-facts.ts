import { isBool, isInt, isStr } from "./guards.js";

/**
 * The run-lifecycle grammar of the SSH wire family (SSH-SUPPORT.md §3,
 * Structured commands): the control modes, the lifecycle states, and the
 * fact envelope that every run answer carries. Split from `ssh-frames.ts`
 * at the Gate A fix round so each file stays a single concern inside the
 * repo size ceiling; the exported NAMES are unchanged and the barrel
 * re-points here.
 *
 * Hand-rolled in the `node-frames.ts` style; imports no `node:` builtin;
 * lives in the Metro-safe barrel.
 */

/* ------------------------------------------------------------------ */
/* control state                                                       */
/* ------------------------------------------------------------------ */

/**
 * Who holds input control of a managed SSH terminal. Humans can take over
 * immediately; ONLY humans return control to agents (SSH-SUPPORT.md §3).
 */
export const SSH_CONTROL_MODES = ["agent", "human"] as const;

/** One side of the input-control boundary. */
export type SshControlMode = (typeof SSH_CONTROL_MODES)[number];

/**
 * `result.error` from an input or prompt-delivery the node refused because its
 * per-pane generation had moved on: a takeover or a revocation fenced it.
 *
 * THE single frozen wire spelling for a generation refusal. There is
 * deliberately no matching member of `SSH_ERROR_CODES` (the Gate A review
 * ruled one event, one name): the plane matches `NodeRpcError.detail` against
 * THIS constant by equality, exactly like every other bare `NODE_RESULT_*`.
 */
export const NODE_RESULT_SSH_GENERATION_STALE = "stale input generation";

/* ------------------------------------------------------------------ */
/* run lifecycle facts                                                 */
/* ------------------------------------------------------------------ */

/**
 * Run lifecycle as a runtime list. `accepted` means the node DURABLY recorded
 * the request before spawning; a crash between acceptance and spawn reads
 * back `unknown`, never a retry. `unknown` must not masquerade as failed or
 * successful - that honesty is why it exists beside `completed`, not under
 * either.
 */
export const SSH_RUN_LIFECYCLES = ["accepted", "running", "completed", "unknown"] as const;

/** One lifecycle state from {@link SSH_RUN_LIFECYCLES}. */
export type SshRunLifecycle = (typeof SSH_RUN_LIFECYCLES)[number];

/**
 * A run ID on the wire: server-allocated, opaque, also the node's filesystem
 * name. Minted to satisfy `isNodeSubshellId`'s grammar; the wire grammar
 * checks stringness and length here, exactly like every existing id-carrying
 * arm (path-composition re-checks are the plane's and the node's).
 */
export function isSshRunId(value: unknown): value is string {
  return isStr(value) && value.length > 0 && value.length <= 64;
}

/**
 * The lifecycle + cancellation/deadline + exit facts of one run, as the
 * start/status/cancel/read answers all carry them. Cancellation and deadline
 * are SEPARATE facts from lifecycle on purpose: a `completed` run may also
 * carry `cancelRequested` (cancelled, then finished cleanly) or
 * `deadlineHit` (won its race against supervision), and a `running` run may
 * already carry a pending cancellation.
 */
export interface SshRunFactsWire {
  /** Echo of the server-allocated opaque run ID (also the node's filesystem name). */
  runId: string;
  /** Lifecycle state at answer time. */
  lifecycle: SshRunLifecycle;
  /** A cancellation was requested for this run. */
  cancelRequested: boolean;
  /**
   * The LOCAL supervised ssh/helper processes are stopped (within
   * `SSH_CANCEL_GRACE_MS`). Remote descendants are never confirmed -
   * terminating SSH never guarantees they died.
   */
  cancelLocalConfirmed: boolean;
  /** The run's execution deadline fired. */
  deadlineHit: boolean;
  /**
   * Observed remote exit status. Only two things may be non-null here:
   * `completed` carries the observed status, and `unknown` may carry the
   * ambiguous OpenSSH 255 - the number that cannot distinguish a transport
   * failure from a remote exit 255 (man.openbsd.org/ssh#EXIT_STATUS), which
   * is precisely the observation that makes the outcome UNKNOWN. Any other
   * remote status with `unknown` is a contradiction the reader refuses
   * (enforced in {@link readSshRunFacts}); `accepted`/`running` carry null.
   */
  remoteStatus: number | null;
  /**
   * True when `remoteStatus` is a CONFIRMED remote program status. A 255
   * seen without corroborating transport facts carries `false`: the number
   * alone must never be asserted as a confirmed remote result. False
   * whenever `remoteStatus` is null.
   */
  remoteStatusConfirmed: boolean;
  /** Local ssh child's exit code (null if it died by signal or status was never seen). */
  localExitCode: number | null;
  /** Signal name that killed the local ssh child (null unless it was signalled). */
  localExitSignal: string | null;
}

/**
 * The facts grammar, shared by every command answer that carries run state.
 * Used by `node-results.ts` and by any consumer that embeds the envelope.
 * The lifecycle/observation cross-check lives HERE (not in the plane's
 * reducer) so neither end can build on a contradictory answer: an `unknown`
 * run may report only the 255 ambiguity as its observation.
 */
export function readSshRunFacts(data: Record<string, unknown>): SshRunFactsWire | null {
  if (!isSshRunId(data.runId)) return null;
  if (
    !(
      data.lifecycle === "accepted" ||
      data.lifecycle === "running" ||
      data.lifecycle === "completed" ||
      data.lifecycle === "unknown"
    )
  )
    return null;
  if (!isBool(data.cancelRequested) || !isBool(data.cancelLocalConfirmed) || !isBool(data.deadlineHit)) return null;
  if (!("remoteStatus" in data) || !(data.remoteStatus === null || isInt(data.remoteStatus))) return null;
  if (data.lifecycle === "unknown" && data.remoteStatus !== null && data.remoteStatus !== 255) return null;
  if (!isBool(data.remoteStatusConfirmed)) return null;
  if (!("localExitCode" in data) || !(data.localExitCode === null || isInt(data.localExitCode))) return null;
  if (!("localExitSignal" in data) || !(data.localExitSignal === null || isStr(data.localExitSignal))) return null;
  return {
    runId: data.runId,
    lifecycle: data.lifecycle as SshRunLifecycle,
    cancelRequested: data.cancelRequested,
    cancelLocalConfirmed: data.cancelLocalConfirmed,
    deadlineHit: data.deadlineHit,
    remoteStatus: data.remoteStatus as number | null,
    remoteStatusConfirmed: data.remoteStatusConfirmed,
    localExitCode: data.localExitCode as number | null,
    localExitSignal: data.localExitSignal as string | null,
  };
}
