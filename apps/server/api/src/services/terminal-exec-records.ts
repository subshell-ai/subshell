import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import type { Kysely } from "kysely";
import type { Database } from "@/db/types/index.js";
import type { NewSshTerminalExec, SshTerminalExecTable } from "@/db/types/ssh-terminal-execs.db-types.js";
import type { LogWindowReader } from "@/services/nodes/log-tail.js";
import { cursorLinesFromWindow, LOG_WINDOW_DEFAULT_BYTES } from "@/services/nodes/log-tail.js";
import {
  createSentinelScanner,
  EXEC_MAX_OUTPUT_BYTES,
  execOutputTail,
  windowIsPartial,
} from "@/services/nodes/pane-exec.js";
import type { SshTerminalExecView } from "@/services/ssh/ssh-api-types.js";
import { logger } from "@/utils/logger.js";

/**
 * Terminal-exec RECORDS (task-C brief deliverable 1; SSH-SUPPORT.md §3,
 * "Existing exec_in_terminal"): the execution ID and its durable outstanding
 * state in `ssh_terminal_execs`, the bounded marker observation that continues
 * past a caller's wait timeout, and the honest `unknown` transition.
 *
 * The record turns the exec helper's synchronous poll into a recoverable
 * receipt: `POST /:id/exec` answers its `executionId`, `GET /:id/execs/:execId`
 * (the `get_terminal_execution` REST door) reads the row back, and a caller
 * that walked away at its timeout learns the truth when the LATE marker lands
 * - the observation stays reserved (the pane's exec lease does NOT release at
 * the caller's timeout), and the row carries the verdict. When observation is
 * LOST (pane restart, pane death, budget exhausted), the row moves to
 * `unknown`: never renamed to failed or completed, and until human recovery
 * or a pane restart it refuses further automated exec on that pane.
 *
 * The observation loop shares pane-exec.ts's scanner (the S1 liveness rule
 * cannot be reimplemented twice) but not its wait: this loop polls slower
 * (every remote poll is a signed `log_read` round trip) and its budget is the
 * module bound below, not the caller's timeout. The pane-incarnation test is
 * the honest restart fact: `paneIncarnation` mirrors the subshell row's
 * `started_at`, and a mismatch means no marker can ever legitimately complete
 * this record.
 */

/** Late-marker poll cadence: one bounded `log_read` per poll (a remote one is a signed round trip). */
export const EXEC_OBSERVE_POLL_MS = 5_000;
/**
 * How long marker observation continues after a caller's wait timed out.
 * Bounded ON PURPOSE (spec §3: "do not monitor or reserve unbounded memory
 * indefinitely"): at the budget's end the row becomes `unknown` - we stopped
 * watching, and that is exactly what unknown means. One hour covers the
 * documented use (a build that prints its sentinel late) at one poll per
 * {@link EXEC_OBSERVE_POLL_MS}.
 */
export const EXEC_OBSERVE_MAX_MS = 60 * 60_000;

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* the store                                                            */
/* ------------------------------------------------------------------ */

/**
 * Insert one outstanding record and seed its observation cursor with the
 * quiet-probe size (where the scan begins, so a re-armed loop after a server
 * restart resumes from the same line boundary the lost one would have read).
 */
export async function insertExec(db: Kysely<Database>, row: NewSshTerminalExec, startCursor: number): Promise<void> {
  await db
    .insertInto("sshTerminalExecs")
    // `createdAt` and `outputTruncated` have DB defaults the gate-A insert
    // shape omits; Kysely's InsertExpression still names them, so the row is
    // written with the same values the defaults would give it.
    .values({ ...row, createdAt: nowIso(), outputTruncated: 0 })
    .execute();
  await db.updateTable("sshTerminalExecs").set({ nextByte: startCursor }).where("id", "=", row.id).execute();
}

/** The record, or null (the status door answers 404 on null). */
export async function loadExec(db: Kysely<Database>, id: string): Promise<SshTerminalExecTable | null> {
  return (await db.selectFrom("sshTerminalExecs").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
}

/**
 * Reconcile rows a restart left behind: an outstanding record whose pane
 * INCARNATION no longer matches can never be completed (the shell that would
 * print the marker is gone) - move it to `unknown`. Lazy by design: called on
 * exec entry, on the status read, and on takeover, so every row is rendered
 * honest the moment anyone asks about the pane again - no background sweeper,
 * and the auto-restart path (which lives in the central manager) is covered
 * by the same read-time fact.
 * @returns how many rows moved
 */
export async function reconcileStaleIncarnation(
  db: Kysely<Database>,
  subshellId: string,
  currentIncarnation: string,
): Promise<number> {
  const res = await db
    .updateTable("sshTerminalExecs")
    .set({ state: "unknown", resolvedAt: nowIso() })
    .where("subshellId", "=", subshellId)
    .where("state", "=", "outstanding")
    .where("paneIncarnation", "<>", currentIncarnation)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/**
 * An explicit takeover (and the revocation path behind it) invalidates the
 * pane's outstanding results NOW: a human touched this pane, and anything the
 * marker might later report is about a command the human may have finished,
 * redone, or typed over. The node-side half of the same act is the raised
 * input generation fencing the queued bytes; this is the record-side half.
 */
export async function invalidateOutstandingExecs(db: Kysely<Database>, subshellId: string): Promise<number> {
  const res = await db
    .updateTable("sshTerminalExecs")
    .set({ state: "unknown", resolvedAt: nowIso() })
    .where("subshellId", "=", subshellId)
    .where("state", "=", "outstanding")
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/**
 * Whether further AUTOMATED exec must wait: the newest record in this pane's
 * CURRENT incarnation is `unknown` (an older `completed` newer than the newest
 * unknown IS the human-recovery fact; a restart moots the whole set by moving
 * the incarnation). Ordering is `(created_at, id)` - the house id-tiebreak,
 * because ISO-millis stamps can collide.
 */
export async function hasBlockingUnknown(
  db: Kysely<Database>,
  subshellId: string,
  currentIncarnation: string,
): Promise<boolean> {
  const newest = await db
    .selectFrom("sshTerminalExecs")
    .select(["state"])
    .where("subshellId", "=", subshellId)
    .where("paneIncarnation", "=", currentIncarnation)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return newest?.state === "unknown";
}

/** Persist the observation cursor as the loop consumes (the crash-resume point). */
export async function advanceExecCursor(db: Kysely<Database>, execId: string, nextByte: number): Promise<void> {
  await db.updateTable("sshTerminalExecs").set({ nextByte }).where("id", "=", execId).execute();
}

/** Resolve a record COMPLETED with the marker's facts. One-shot: only an outstanding row transitions. */
export async function completeExec(
  db: Kysely<Database>,
  execId: string,
  exitCode: number,
  output: string | null,
  outputTruncated: boolean,
  nextByte: number,
): Promise<boolean> {
  const res = await db
    .updateTable("sshTerminalExecs")
    .set({
      state: "completed",
      exitCode,
      output,
      outputTruncated: outputTruncated ? 1 : 0,
      nextByte,
      resolvedAt: nowIso(),
    })
    .where("id", "=", execId)
    .where("state", "=", "outstanding")
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

/** Resolve a record UNKNOWN (observation lost: budget, death, restart, takeover). One-shot. */
export async function markExecUnknown(db: Kysely<Database>, execId: string, nextByte?: number): Promise<boolean> {
  const res = await db
    .updateTable("sshTerminalExecs")
    .set({ state: "unknown", resolvedAt: nowIso(), ...(nextByte !== undefined ? { nextByte } : {}) })
    .where("id", "=", execId)
    .where("state", "=", "outstanding")
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

/** The row as the frozen `SshTerminalExecView` (read-only; the status route serializes it). */
export function toExecView(row: SshTerminalExecTable): SshTerminalExecView {
  return {
    id: row.id,
    subshellId: row.subshellId,
    state: row.state,
    exitCode: row.exitCode,
    output: row.output,
    outputTruncated: row.outputTruncated === 1,
    nextByte: row.nextByte,
    inputGeneration: row.inputGeneration,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/* ------------------------------------------------------------------ */
/* the observation loop (module-scoped, like the exec lease itself)     */
/* ------------------------------------------------------------------ */

/** What one running observation needs from the caller - the launcher-side seam, injected. */
export interface ObservationDeps {
  /** Bounded window read of the pane log (the SAME reader the caller's wait used). */
  read: LogWindowReader;
  /**
   * Whether the pane is still the SAME live pane: running, alive, and at the
   * record's incarnation. False answers the unknown transition; a THROW counts
   * as not-current (fail-closed: a blip while asking may be the death).
   */
  isPaneCurrent: () => Promise<boolean>;
  /** Injectable pacing/clock (tests own time). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** In-flight observations by exec id (and a pane→exec mirror for the lease). Module-scoped because `SubshellsService` is per request: a late marker must be caught exactly ONCE per process. */
const observations = new Map<string, Promise<void>>();
const bySubshell = new Map<string, string>();

/** Whether an observation is actively running for this record right now. */
export function observationActive(execId: string): boolean {
  return observations.has(execId);
}

/** The exec currently under observation for a pane, or null (the pane's reservation). */
export function activeObservationForSubshell(subshellId: string): string | null {
  return bySubshell.get(subshellId) ?? null;
}

/**
 * Stop treating a pane's exec as watched: mark its outstanding record `unknown`
 * NOW (the takeover/terminate fact). The running loop is deliberately NOT
 * awaited: the one-shot `where state = outstanding` guards on completion make
 * it impossible for the watcher to resurrect the row - after this, a marker
 * arriving on the next poll finds no outstanding record - and the watcher's
 * own poll notices the pane is gone and retires itself. Awaiting here would
 * deadlock a caller whose clock controls the loop's sleep.
 * @returns how many records moved (0 when nothing was being observed)
 */
export async function cancelObservation(db: Kysely<Database>, subshellId: string): Promise<number> {
  const execId = bySubshell.get(subshellId);
  if (!execId) return 0;
  return (await markExecUnknown(db, execId)) ? 1 : 0;
}

/**
 * Watch for the marker PAST a caller's wait, until the sentinel lands, the
 * pane stops being the same live pane, or the budget ends. Idempotent per exec
 * id: re-arming a record already under observation returns the SAME promise -
 * which is how the status read revives observation after a server restart
 * without ever running two loops on one pane.
 *
 * Output accumulation lives in memory while the loop runs (the persisted
 * `output` column is a resolved-record field): a server restart between the
 * timeout and the marker loses the pre-restart lines, so the completed tail
 * after a re-arm carries what the RESUMED scan saw - a degraded tail, never a
 * fabricated one. The cursor is persisted as it advances, so the resumed scan
 * starts where the lost one stopped.
 *
 * @returns resolves when the record has reached a terminal state (`completed`
 *          or `unknown`) - the pane's exec reservation lives as long as this.
 */
export function observeExecToResolution(
  db: Kysely<Database>,
  exec: {
    id: string;
    subshellId: string;
    markerToken: string;
    /** Where the last wait stopped (or the quiet size when nothing waited yet). */
    startByte: number;
    /** Lines the caller's wait already captured (the newest-tail seed). */
    priorLines: string[];
    budgetMs?: number;
  },
  deps: ObservationDeps,
): Promise<void> {
  const existing = observations.get(exec.id);
  if (existing) return existing;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const budgetMs = exec.budgetMs ?? EXEC_OBSERVE_MAX_MS;

  const run = (async (): Promise<void> => {
    let cursor = exec.startByte;
    let deadline = 0;
    try {
      // INSIDE the try, not before it: a stored marker token that fails the
      // grammar (data written by an older build, or by hand) must render the
      // honest `unknown`, not a rejected promise nobody awaits.
      const scanner = createSentinelScanner(exec.markerToken);
      deadline = now() + budgetMs;
      for (;;) {
        let current = false;
        try {
          current = await deps.isPaneCurrent();
        } catch {
          current = false;
        }
        if (!current) {
          await markExecUnknown(db, exec.id, cursor);
          return;
        }
        let bytes: Uint8Array;
        let size: number;
        try {
          const win = await deps.read(cursor, LOG_WINDOW_DEFAULT_BYTES);
          bytes = win.bytes;
          size = win.size;
        } catch {
          // A transport blip is "no data this poll" (the wait loop's own rule):
          // a late marker must survive a flaky link; the deadline renders the
          // honest verdict if nothing else does.
          bytes = new Uint8Array(0);
          size = cursor;
        }
        const { lines, nextByte } = cursorLinesFromWindow(bytes, cursor, size);
        if (lines.length > 0) {
          const hit = scanner.push(lines, windowIsPartial(bytes));
          if (hit) {
            const tail = execOutputTail([...exec.priorLines, ...scanner.output()], EXEC_MAX_OUTPUT_BYTES);
            await completeExec(db, exec.id, hit.rc, tail.text === "" ? null : tail.text, tail.truncated, nextByte);
            return;
          }
          cursor = nextByte;
          await advanceExecCursor(db, exec.id, cursor);
        }
        if (now() >= deadline) {
          await markExecUnknown(db, exec.id, cursor);
          return;
        }
        await sleep(EXEC_OBSERVE_POLL_MS);
      }
    } catch (err) {
      // The loop's own failure (a DB throw mid-transition): the record must not
      // sit outstanding with no watcher. Unknown is the honest rest state;
      // every caller that armed the watch already has its answer.
      logger.withError(err).warn(`exec observation failed for ${exec.id}; marking unknown`);
      await markExecUnknown(db, exec.id, cursor).catch(() => {});
    }
  })().finally(() => {
    observations.delete(exec.id);
    if (bySubshell.get(exec.subshellId) === exec.id) bySubshell.delete(exec.subshellId);
  });

  observations.set(exec.id, run);
  bySubshell.set(exec.subshellId, exec.id);
  return run;
}

/* ------------------------------------------------------------------ */
/* the pane reservation (was `execInFlight` in the service; now here     */
/* because a timed-out exec's reservation is its observation, not its    */
/* caller)                                                              */
/* ------------------------------------------------------------------ */

/**
 * One reservation per pane, taken SYNCHRONOUSLY before the first await (the
 * old lease's rule - two racing calls must never both proceed) and released
 * when the whole watched life of the exec ends: the caller's wait AND any
 * observation it left running. `SubshellsService` is per request, so the map
 * is module-scoped exactly like `restartInFlight` in the manager.
 */
const holds = new Map<string, Promise<void>>();
const holdResolvers = new Map<string, () => void>();

/** Claim the pane for one exec. False = already claimed (the EXEC_IN_FLIGHT answer). */
export function tryHoldPane(subshellId: string): boolean {
  if (holds.has(subshellId)) return false;
  let release: () => void = () => {};
  holds.set(
    subshellId,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  holdResolvers.set(subshellId, release);
  return true;
}

/** Whether the pane's exec reservation is active right now (the EXEC_IN_FLIGHT check). */
export function paneHeld(subshellId: string): boolean {
  return holds.has(subshellId);
}

/**
 * Release the reservation. A timed-out caller hands the hold to its
 * observation: the pane stays reserved until the late marker lands, the
 * watcher gives up, or the pane stops being current - which is exactly the
 * brief's "the reservation stays active" sentence, and it is why a second
 * exec during a late-marker watch answers EXEC_IN_FLIGHT, not double-types.
 */
export function releasePane(subshellId: string, observation?: Promise<void>): void {
  const release = holdResolvers.get(subshellId);
  if (!release) return;
  if (observation) {
    void observation.finally(() => {
      if (holdResolvers.get(subshellId) === release) {
        holdResolvers.delete(subshellId);
        holds.delete(subshellId);
      }
      release();
    });
    return;
  }
  holdResolvers.delete(subshellId);
  holds.delete(subshellId);
  release();
}

/**
 * The exec gate's after-unknown refusal (shared shape so every entry point
 * answers identically). Human-CLASS callers pass it - they are the recovery the
 * rule waits for, and they can SEE the pane; per the shipped M5 ruling (the
 * exec gate in `subshells.service.ts`) human-class is COOKIE AND SYSTEM KEY,
 * and the ONLY actor refused here is the bearer SUBSHELL key - the
 * prompt-injectable automated caller the rule was written against. A system key
 * resolves through the full human gate as the `system` service user everywhere
 * else in this tree, so waiting it would contradict that posture; it waits for
 * nothing. Only a completed record succeeding the unknown one, or a pane
 * restart, clears it for the bearer.
 */
export function refuseAfterUnknown(): never {
  throwApiError({
    code: BackendErrorCodes.EXEC_UNKNOWN_RECOVERY,
    message:
      "A previous exec on this pane ended with unknown state; recover it by hand or restart the pane before running more automated commands",
    doNotLog: true,
  });
}
