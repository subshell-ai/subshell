import { SSH_COMPLETED_RUN_RETENTION_MS } from "@internal/subshell-protocol";
import { sql } from "kysely";
import { db } from "@/db/index.js";
import { sshRunsRepo } from "@/services/ssh/ssh-run-mirror.js";
import { logger } from "@/utils/logger.js";

/**
 * Retention for the runs mirror (SSH-SUPPORT.md §3's "Completed-run
 * retention: 7 days" row) AND the terminal-exec records (review I6: every
 * `exec_in_terminal` inserts a durable row with up to a 256 KiB output tail
 * and, beside the pane's own cascade, nothing aged them out - "bound
 * accumulation" is plan language). Imitates `pane-log-hygiene.ts`'s scheduling
 * and its central safety rule - a sweep deletes only rows that provably can
 * produce no more facts: for runs, `status` terminal AND the terminal stamp
 * (or, for rows predating stamping, `updated_at`) older than the window; for
 * exec records, `state != outstanding` AND the resolution stamp (or, for rows
 * predating it, `created_at`) older than the window. Active rows are never
 * candidates; the predicate is the "running logs are never swept" posture
 * moved from files to rows.
 *
 * The same pass settles ORPHANS: a run whose NODE was deleted (the SET NULL
 * column) can never be asked again, so an unsettled row there is settled to
 * `unknown` (honest, final, retention-eligible) rather than left `accepted`
 * forever by a node that is gone.
 *
 * Window source: `SSH_RUN_RETENTION_DAYS` env (whole days, `0` = keep
 * forever), default the frozen §3 row of 7. Read per pass like every other
 * env knob here, so an operator flipping it takes effect next tick. exec
 * records deliberately SHARE the run window: one knob bounds all the SSH
 * durable-row accumulation, and an exec output tail is no worthier of a
 * longer hold than the run output that already ages at 7 days.
 *
 * Wiring (boot + hourly, like the pane-log pass) is the task-D report's
 * index.ts integration request.
 */

/** Days-to-ms with the spec default; a non-numeric or negative value falls back to the default (never a surprise delete). */
export function sshRetentionWindowMs(rawDays: string | undefined = process.env.SSH_RUN_RETENTION_DAYS): number {
  if (rawDays === undefined || rawDays.trim() === "") return SSH_COMPLETED_RUN_RETENTION_MS;
  const days = Number(rawDays);
  if (!Number.isFinite(days) || days < 0) return SSH_COMPLETED_RUN_RETENTION_MS;
  if (days === 0) return Number.POSITIVE_INFINITY;
  return days * 24 * 60 * 60 * 1000;
}

/** Run one sweep. Returns the row counts it removed (for the boot log line and tests). */
export async function sweepExpiredSshRuns(
  now: Date = new Date(),
  windowMs: number = sshRetentionWindowMs(),
): Promise<{ deleted: number; orphaned: number; execsSwept: number }> {
  const runs = sshRunsRepo();
  const orphaned = await settleOrphanedRuns(runs, now);
  if (!Number.isFinite(windowMs)) return { deleted: 0, orphaned, execsSwept: 0 };
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const deleted = await runs.deleteCompletedBefore(cutoff);
  if (deleted > 0) logger.info(`ssh run retention swept ${deleted} completed run record(s)`);
  const execsSwept = await sweepTerminalExecsBefore(cutoff);
  if (execsSwept > 0) logger.info(`ssh run retention swept ${execsSwept} resolved terminal-exec record(s)`);
  return { deleted, orphaned, execsSwept };
}

/**
 * Delete RESOLVED terminal-exec rows older than `cutoffIso` (review I6). A
 * record can produce no more facts once it has left `outstanding` - the
 * one-shot transitions (`completeExec`/`markExecUnknown`, guarded on
 * `state = 'outstanding'`) make a resolved row immutable, and the observation
 * loop has retired - so the recovery handle (`get_terminal_execution`) may
 * stop answering after the window, exactly as the run output it mirrors ages
 * out. `outstanding` rows are NEVER candidates: the late-marker wait is what
 * they exist for, and deleting one would silently drop a pending exec's
 * result. `COALESCE(resolved_at, created_at)` covers a resolved row that
 * predates `resolved_at` stamping (the pane-log-hygiene asymmetry: an old row
 * with a terminal state and no stamp still ages, on its typing time).
 */
async function sweepTerminalExecsBefore(cutoffIso: string): Promise<number> {
  const rows = await db
    .selectFrom("sshTerminalExecs")
    .select("id")
    .where("state", "!=", "outstanding")
    .where((eb) => eb(sql<string>`COALESCE(resolved_at, created_at)`, "<", cutoffIso))
    .execute();
  if (rows.length === 0) return 0;
  await db
    .deleteFrom("sshTerminalExecs")
    .where(
      "id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  return rows.length;
}

/**
 * Settle runs whose node row was deleted (node_id NULL) and which are still
 * `accepted`/`running`: the machine that holds their truth is gone and the
 * reconcile pass will never ask it. `applyFacts` with `unknown` is the
 * honest final state (never failed, never completed).
 */
async function settleOrphanedRuns(runs: ReturnType<typeof sshRunsRepo>, now: Date): Promise<number> {
  const rows = await runs.listOrphans();
  for (const row of rows) {
    await runs.applyFacts(row.id, {
      runId: row.id,
      lifecycle: "unknown",
      cancelRequested: row.cancelRequested === 1,
      cancelLocalConfirmed: row.cancelLocalConfirmed === 1,
      deadlineHit: row.deadlineHit === 1,
      remoteStatus: null,
      remoteStatusConfirmed: false,
      localExitCode: null,
      localExitSignal: null,
    });
    // finishedAt must be stampable now, not left from the terminal CASE
    // (applyFacts sets it with the server clock on terminal observation,
    // which IS this write).
  }
  if (rows.length > 0)
    logger.info(
      `ssh run retention settled ${rows.length} orphaned run(s) to unknown (node deleted) ${now.toISOString()}`,
    );
  return rows.length;
}
