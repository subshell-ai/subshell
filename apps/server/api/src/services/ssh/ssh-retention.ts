import { SSH_COMPLETED_RUN_RETENTION_MS } from "@internal/subshell-protocol";
import { sshRunsRepo } from "@/services/ssh/ssh-runs.service.js";
import { logger } from "@/utils/logger.js";

/**
 * Retention for the runs mirror (SSH-SUPPORT.md §3's "Completed-run
 * retention: 7 days" row). Imitates `pane-log-hygiene.ts`'s scheduling and
 * its central safety rule - a sweep deletes only rows that provably can
 * produce no more facts: `status` is terminal AND the terminal stamp (or,
 * for rows predating stamping, `updated_at`) is older than the window.
 * Active rows are never candidates; the predicate is the "running logs are
 * never swept" posture moved from files to rows.
 *
 * The same pass settles ORPHANS: a run whose NODE was deleted (the SET NULL
 * column) can never be asked again, so an unsettled row there is settled to
 * `unknown` (honest, final, retention-eligible) rather than left `accepted`
 * forever by a node that is gone.
 *
 * Window source: `SSH_RUN_RETENTION_DAYS` env (whole days, `0` = keep
 * forever), default the frozen §3 row of 7. Read per pass like every other
 * env knob here, so an operator flipping it takes effect next tick.
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
): Promise<{ deleted: number; orphaned: number }> {
  const runs = sshRunsRepo();
  const orphaned = await settleOrphanedRuns(runs, now);
  if (!Number.isFinite(windowMs)) return { deleted: 0, orphaned };
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const deleted = await runs.deleteCompletedBefore(cutoff);
  if (deleted > 0) logger.info(`ssh run retention swept ${deleted} completed run record(s)`);
  return { deleted, orphaned };
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
