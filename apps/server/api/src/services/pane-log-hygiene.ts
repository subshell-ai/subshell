import { chmodSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { subshellLogDir } from "@/services/nodes/subshell-paths.js";
import { logger } from "@/utils/logger.js";

/**
 * Housekeeping for the pane-log directory — the plaintext transcripts written
 * by tmux's `pipe-pane` (see {@link subshellLogDir}).
 *
 * These files deserve their own module because of what they hold. A pane log
 * is every byte the terminal rendered, and a tty echoes: an API token pasted
 * into a prompt, an `export SECRET=…`, and whatever the commands printed back
 * are all in there verbatim. Two properties follow, and neither was true
 * before this module existed:
 *
 * 1. **They are not world-readable.** New logs are created 0600 by the umask
 *    in the pipe-pane command itself (`TmuxRunner.pipePane`); this module
 *    retro-tightens the directory and any log written before that fix, which
 *    a boot sweep would otherwise leave at the 0644 the old code produced.
 * 2. **They do not live forever.** A subshell's log used to be unlinked only
 *    on DELETE, so a terminated-but-kept subshell held its full transcript
 *    indefinitely. {@link sweepExpiredPaneLogs} ages them out instead.
 *
 * Both functions are best-effort and total: housekeeping must never take the
 * server down, so every fs failure is logged and swallowed.
 */

const DAY_MS = 86_400_000;

/** Log file names are `<subshell id>.log`; nothing else in the dir is ours. */
const LOG_SUFFIX = ".log";

/** What one {@link tightenPaneLogModes} pass changed. */
export interface TightenResult {
  /** Whether the directory itself was found and re-moded. */
  dir: boolean;
  /** How many `<id>.log` files were re-moded. */
  files: number;
}

/**
 * Forces the pane-log directory to 0700 and every log inside it to 0600.
 *
 * Runs at boot, unconditionally, because it is a REPAIR: logs created before
 * the pipe-pane umask fix are 0644 on disk and nothing else will ever revisit
 * them. It is cheap (a readdir plus a chmod per file) and idempotent, so
 * running it on every boot costs nothing on an already-clean instance.
 *
 * Only `<id>.log` files are touched. The pane-log directory is the database
 * file's own directory by default, so it holds things this module has no
 * business re-moding.
 *
 * @param dir - the directory to tighten (defaults to the real pane-log dir)
 */
export function tightenPaneLogModes(dir: string = subshellLogDir()): TightenResult {
  if (!existsSync(dir)) return { dir: false, files: 0 };
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    logger.withError(err).warn(`pane log hygiene: could not tighten ${dir} to 0700`);
    return { dir: false, files: 0 };
  }
  let files = 0;
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith(LOG_SUFFIX)) continue;
    try {
      chmodSync(join(dir, name), 0o600);
      files += 1;
    } catch (err) {
      logger.withError(err).debug(`pane log hygiene: could not tighten ${name} to 0600`);
    }
  }
  return { dir: true, files };
}

/** Inputs to one retention pass. */
export interface SweepOptions {
  /** Directory to sweep (defaults to the real pane-log dir). */
  dir?: string;
  /** Age in days after which a non-running subshell's log is removed; 0 = keep forever. */
  retentionDays: number;
  /**
   * Ids of subshells that are RUNNING right now. Their logs are never swept,
   * whatever the file's mtime says — a long-lived agent that has printed
   * nothing for months still has viewers replaying from that file.
   */
  runningIds: ReadonlySet<string>;
  /** Clock, injectable so the boundary is testable. */
  nowMs?: number;
}

/** What one {@link sweepExpiredPaneLogs} pass removed. */
export interface SweepResult {
  /** Subshell ids whose log file was unlinked. */
  removed: string[];
}

/**
 * Deletes pane logs that have aged out.
 *
 * A log is eligible when its subshell is not in `runningIds` — terminated, or
 * an orphan whose row is gone and whose unlink failed at delete time — AND its
 * mtime is strictly older than the retention window. Liveness is taken from
 * the caller's set rather than from the row's `status` column so that an
 * orphaned file (no row at all) is swept rather than skipped.
 *
 * Deliberately NOT delete-on-terminate: the UI shows a terminated subshell's
 * transcript, and destroying it the instant the pane dies would trade a real
 * feature for a security gain this age-out already delivers.
 */
export function sweepExpiredPaneLogs(opts: SweepOptions): SweepResult {
  const { retentionDays, runningIds } = opts;
  const dir = opts.dir ?? subshellLogDir();
  const removed: string[] = [];
  // 0 is the documented opt-out, and a negative value can only be a
  // misconfiguration — neither may be read as "delete everything".
  if (retentionDays <= 0 || !existsSync(dir)) return { removed };

  const cutoffMs = (opts.nowMs ?? Date.now()) - retentionDays * DAY_MS;
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith(LOG_SUFFIX)) continue;
    const id = name.slice(0, -LOG_SUFFIX.length);
    if (runningIds.has(id)) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtime.getTime() >= cutoffMs) continue;
      unlinkSync(file);
      removed.push(id);
    } catch (err) {
      // A file that vanished under us (a concurrent DELETE) is the sweep's
      // job done by someone else, not a failure worth a warning.
      logger.withError(err).debug(`pane log hygiene: could not sweep ${name}`);
    }
  }
  if (removed.length > 0) {
    logger.info(`pane log retention: removed ${removed.length} log(s) older than ${retentionDays}d`);
  }
  return { removed };
}

/** `readdirSync` that answers `[]` instead of throwing on an unreadable dir. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    logger.withError(err).warn(`pane log hygiene: could not read ${dir}`);
    return [];
  }
}
