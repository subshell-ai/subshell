/**
 * `subshell-server backup [--json]` — take a database snapshot now.
 *
 * Its own verb rather than a flag of `update` (spec 2026-09-15 §4.1), because
 * the reason to take one by hand is precisely that you are NOT updating:
 * before a hand-edit of the database, before a migration you are testing,
 * before deleting an account. `update` takes its own, and the two land in the
 * same directory under the same retention, so there is one place to look.
 *
 * ASYNC like `update`, and for the same reason: {@link backupDatabase} is.
 */
import { backupDatabase, listBackups } from "@/services/db-backup.js";

/** stdio seams, so a test observes the lines without a subprocess. */
export interface BackupDeps {
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * Run the verb.
 *
 * @returns 0 with the path and size printed, or 1 with the reason — the one
 *   refusal being a host with no database yet, which is a real state on a
 *   configured server that has never booted.
 */
export async function runBackup(opts: { json?: boolean }, deps: BackupDeps): Promise<number> {
  let written: Awaited<ReturnType<typeof backupDatabase>>;
  try {
    written = await backupDatabase({ reason: "manual" });
  } catch (err) {
    deps.error(`subshell-server: could not back up the database: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (written === null) {
    deps.error("subshell-server: there is no database to back up yet");
    return 1;
  }
  if (opts.json) deps.log(JSON.stringify({ ...written, kept: listBackups().length }));
  else deps.log(`${written.path} (${written.bytes} bytes)`);
  return 0;
}
