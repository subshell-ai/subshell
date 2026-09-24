/**
 * A single-file snapshot of the database, taken before anything migrates over
 * it (spec 2026-09-15 §4.1).
 *
 * Before this existed, nothing in the app had ever copied the database. An
 * update runs migrations, Kysely's migrator is forward-only, and a migration
 * that fails halfway leaves a schema no version of the server can boot on — so
 * the backup is not a convenience, it is the only thing that makes an update
 * reversible.
 *
 * **MEASURED (spec §12.1, 2026-09-15, bun 1.4.2 / SQLite 3.51.0).** `VACUUM
 * INTO` on a LIVE WAL database, from a second read-only `bun:sqlite`
 * connection with the writer still inserting, produced a consistent snapshot
 * of the committed state at that moment: `PRAGMA integrity_check` → `ok`, no
 * `-wal` and no `-shm` beside it, the 100 rows written AFTER the vacuum
 * absent from the copy and present in the original. So the fallback the spec
 * named (`BEGIN IMMEDIATE` + `wal_checkpoint(TRUNCATE)` + `copyFile`) is not
 * needed and is not implemented.
 *
 * Two consequences of that same measurement are load-bearing here:
 *
 * - **SQLite creates the file with the process umask** — 0644 was measured —
 *   so the `chmod` after the vacuum is what makes 0600 true, not a hope.
 *   The file holds credential hashes, API-key hashes, audit rows and channel
 *   ciphertext: it is the most sensitive single file this app writes.
 * - **The snapshot's own `journal_mode` is `delete`, not WAL.** That is what
 *   makes it a single file with no sidecars, and it is also why
 *   {@link restoreDatabase} checkpoints the replaced file and then deletes
 *   its `-wal`/`-shm` before renaming the snapshot in: a stale sidecar beside
 *   a restored main file is NOT inert — it is replayed (measured, in
 *   {@link restoreDatabase}'s doc comment).
 */
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DATABASE_PATH, SUBSHELL_DB_BACKUPS_KEEP, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { SERVER_VERSION } from "@/version.js";

/** Where backups live — inside the data dir, so the desktop reset's paths already cover them. */
export function backupsDir(): string {
  return join(SUBSHELL_SERVER_DATA_DIR, "backups");
}

/**
 * The file-name shape, and the ONE place it is written or read.
 *
 * The version is in the name because the first question about a backup is
 * "which server wrote this", and the timestamp because the second is "when".
 * Sortable by string, which is what lets {@link listBackups} order by name
 * rather than by mtime — an mtime a copy or a restore can change.
 */
const BACKUP_PREFIX = "subshell-v";
const BACKUP_SUFFIX = ".db";

/** `YYYYMMDD-HHmmss` in UTC — sortable, and unambiguous across a DST boundary. */
function stamp(at: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
  );
}

/**
 * A backup path in this directory that nothing occupies yet.
 *
 * The name's resolution is one SECOND, so two backups of the same version
 * inside one second collide — and `VACUUM INTO` REFUSES an existing file
 * ("output file already exists") rather than overwriting it, which would turn
 * an update into a failure for a reason that has nothing to do with the
 * update. Measured in this repo's own suite on 2026-09-15, where two updates
 * ran back to back.
 *
 * The disambiguator is a `-2`, `-3` … suffix rather than finer timestamps,
 * because the stamp is also what {@link listBackups} sorts on: sub-second
 * precision would make the names less readable to buy ordering that the
 * suffix already preserves (`…-000004.db` sorts before `…-000004-2.db`).
 */
function freeName(dir: string, version: string, at: Date): string {
  const base = join(dir, `${BACKUP_PREFIX}${version}-${stamp(at)}`);
  if (!existsSync(`${base}${BACKUP_SUFFIX}`)) return `${base}${BACKUP_SUFFIX}`;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}${BACKUP_SUFFIX}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find a free backup name in ${dir}`);
}

/** Why a backup was taken. Recorded in the log line, never in the file name. */
export type BackupReason = "update" | "manual";

/** One backup on disk. */
export interface BackupFile {
  /** Absolute path. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** The file's mtime, ISO 8601 — when it was written. */
  at: string;
}

/**
 * What one {@link backupDatabase} call did.
 *
 * It returns `pruned` rather than LOGGING it, and that is deliberate: this
 * module is reached by `subshell-server backup --json`, whose whole contract is
 * one JSON line on stdout — and LogLayer's console transport writes there too.
 * A log line here put an `INFO database backup: …` in front of the JSON and
 * broke every parser (measured 2026-09-15, in this repo's own `test:cli`). The
 * boot and route callers log it themselves, where stdout is a journal.
 */
export interface BackupResult extends BackupFile {
  /** Paths the retention pass removed, oldest first; `[]` when nothing aged out. */
  pruned: string[];
}

/** Injectable seams so a test can point this at a temp database. */
export interface BackupDeps {
  /** The database to snapshot (default: the configured {@link DATABASE_PATH}). */
  databasePath?: string;
  /** Where snapshots go (default: {@link backupsDir}). */
  dir?: string;
  /** How many to keep; `0` = keep forever (default: `SUBSHELL_DB_BACKUPS_KEEP`). */
  keep?: number;
  /** The clock (default: `Date`). */
  now?: () => Date;
}

/**
 * Snapshot the database, prune to the retention count, and return what was
 * written.
 *
 * @returns the backup, or `null` when there is no database file to back up —
 *   a fresh install that has never booted. That is a real state on the update
 *   path (install, configure, update, boot), so the caller SAYS "no database
 *   yet; nothing to back up" rather than failing.
 */
export async function backupDatabase(
  input: { reason: BackupReason; version?: string } & BackupDeps,
): Promise<BackupResult | null> {
  const dbPath = input.databasePath ?? DATABASE_PATH;
  if (!existsSync(dbPath)) return null;

  const dir = input.dir ?? backupsDir();
  const version = input.version ?? SERVER_VERSION;
  const at = (input.now ?? (() => new Date()))();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // An existing directory keeps whatever mode it had, so repair it the way
  // pane-log hygiene does — a 0755 backups directory from an older build would
  // otherwise stay world-readable forever.
  chmodSync(dir, 0o700);

  const path = freeName(dir, version, at);
  // A second, READ-ONLY connection: the app's own handle stays open and
  // serving, and `VACUUM INTO` needs no writer.
  const source = new Database(dbPath, { readonly: true });
  try {
    // The path is a SQL string literal here, so single quotes are doubled.
    // It is ours (data dir + version + timestamp) rather than user input, but
    // a data dir an operator chose can contain anything a file name can.
    source.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  } finally {
    try {
      source.close();
    } catch {
      // A handle that will not close is not a reason to fail a snapshot that
      // has already been written.
    }
  }
  // SQLite created it with the umask (0644 measured); this is what makes 0600 true.
  chmodSync(path, 0o600);
  const bytes = statSync(path).size;

  const pruned = prune(dir, input.keep ?? SUBSHELL_DB_BACKUPS_KEEP);
  return { path, bytes, at: statSync(path).mtime.toISOString(), pruned };
}

/**
 * Every backup in the directory, NEWEST FIRST.
 *
 * Ordered by the name's own timestamp rather than by mtime: a restore, a copy
 * or an rsync rewrites mtimes, and the point of this list is which snapshot is
 * of which moment. Files that do not match the name shape are ignored — the
 * directory is the operator's too, and a file they put there is not ours to
 * list or to prune.
 */
export function listBackups(dir: string = backupsDir()): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No directory means no backups, which is the ordinary state before the
    // first update — never an error on a view.
    return [];
  }
  const files: BackupFile[] = [];
  for (const name of names) {
    if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      files.push({ path, bytes: st.size, at: st.mtime.toISOString() });
    } catch {
      // Vanished between readdir and stat — not ours to report.
    }
  }
  // Ordered by the STAMP and its sequence, parsed out of the name — not by the
  // whole name and not by mtime. Two reasons, each with a wrong answer behind
  // it: a version number sorts BEFORE the timestamp in the file name, so a
  // plain name compare orders `v0.9.0` above `v0.10.0` and calls an older
  // snapshot newer; and two backups in the same second share an mtime to the
  // millisecond, so the clock cannot tell them apart at all.
  return files.sort((a, b) => {
    const left = ordinal(a.path);
    const right = ordinal(b.path);
    return right.stamp === left.stamp ? right.seq - left.seq : right.stamp.localeCompare(left.stamp);
  });
}

/**
 * A backup's position in time, from its own name: the `YYYYMMDD-HHmmss` stamp
 * and the `-N` same-second sequence ({@link freeName}), which is 1 when absent.
 */
function ordinal(path: string): { stamp: string; seq: number } {
  const match = basename(path).match(/-(\d{8}-\d{6})(?:-(\d+))?\.db$/);
  return { stamp: match?.[1] ?? "", seq: match?.[2] === undefined ? 1 : Number.parseInt(match[2], 10) };
}

/**
 * Delete everything beyond the newest `keep`. `keep <= 0` prunes nothing.
 * @returns what it removed, so the CALLER can report it
 */
function prune(dir: string, keep: number): string[] {
  if (keep <= 0) return [];
  const removed: string[] = [];
  for (const file of listBackups(dir).slice(keep)) {
    try {
      rmSync(file.path, { force: true });
      removed.push(file.path);
    } catch {
      // A file we cannot remove is not a reason to fail the backup that
      // succeeded; the next prune retries.
    }
  }
  return removed;
}

/**
 * Put a backup back, replacing the live database.
 *
 * ONLY for the rollback paths, and only while NO connection is open — the boot
 * hook runs it before `runMigrations()`, and the CLI runs it with the service
 * stopped. Restoring under a live handle would leave that handle holding a
 * deleted inode and writing into nothing.
 *
 * The `-wal` and `-shm` sidecars are deleted as part of the swap (2026-09-24,
 * round-3 sweep C8). They belong to the file being replaced, and stale ones
 * are NOT inert: measured on bun 1.4.2 / this repo's SQLite, a self-consistent
 * WAL left beside a restored snapshot IS replayed onto it on the next open
 * (a snapshot read expecting 10 rows answered 12), even though the snapshot
 * itself is a `journal_mode=delete` database. So they go before the rename —
 * but only after the file being replaced has had its own WAL CHECKPOINTED,
 * which is what closes the window this function used to leave open: the old
 * order unlinked the sidecars first, and a crash before the rename left the
 * not-yet-replaced main file missing its uncheckpointed tail, the next open
 * silently succeeding onto the truncated state — a quiet data loss where the
 * revert was supposed to be the loud kind. With the checkpoint first, every
 * crash between the unlink and the rename leaves a live database that is
 * whole (tail folded in), the revert simply re-runs on the next boot.
 *
 * Either the whole restore happens or none of it does — see the staging
 * comment in the body for why a half-done one is worse than a failed one. A
 * crash before the rename leaves only a `<db>.restore-<pid>` staging file,
 * which the next entry sweeps.
 */
export function restoreDatabase(backupPath: string, databasePath: string = DATABASE_PATH): void {
  if (!existsSync(backupPath)) throw new Error(`the backup ${backupPath} is not there`);

  // Sweep the staging file a previously-crashed restore left behind. This is
  // the entry point a crashed boot comes back through, and the name carries
  // the dead process's pid, so nothing would ever remove it otherwise.
  sweepStagedRestores(databasePath);

  // STAGE BESIDE THE TARGET, THEN RENAME. Never `rmSync(databasePath)` before
  // the replacement bytes are on disk: the caller that matters here is
  // `revertUpdate`, which CATCHES a restore failure and carries on to put the
  // old binary back. So a copy that dies midway — `ENOSPC` is the realistic
  // one, since a revert follows an ~80 MB binary and a full snapshot onto a
  // host already short of room — would leave no database at all, and the old
  // binary would then boot on a hole: `new Database(path)` CREATES the file,
  // the migrator builds an empty schema, and the instance comes up with zero
  // users. An empty instance opens registration (the no-users carve-out in
  // `services/registration-gate.ts`), so the failure mode is not "lost data
  // plus a log line", it is a reachable server anyone can claim.
  //
  // `rename(2)` within one directory is atomic and replaces the destination,
  // so the live file survives untouched until the moment it is superseded.
  const staged = `${databasePath}.restore-${process.pid}`;
  try {
    copyFileSync(backupPath, staged);
    chmodSync(staged, 0o600);
    // Fold the file being replaced's own WAL into it BEFORE dropping the
    // sidecars (see the doc comment for the crash arithmetic). Only worth an
    // open when there ARE sidecars; a plain file needs no ceremony, and this
    // runs on paths where the database file may not exist at all.
    if (existsSync(databasePath) && (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`))) {
      const live = new Database(databasePath);
      try {
        live.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        live.close();
      }
    }
    for (const sidecar of ["-wal", "-shm"]) rmSync(`${databasePath}${sidecar}`, { force: true });
    renameSync(staged, databasePath);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * Delete every leftover staging file for this database (`<db>.restore-<pid>`,
 * from any pid) — the debris of a restore that died before its rename.
 * Best-effort by construction: a leftover this process cannot remove must not
 * be why a rollback refuses to run.
 */
function sweepStagedRestores(databasePath: string): void {
  const dir = dirname(databasePath);
  const prefix = `${basename(databasePath)}.restore-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Leave it; the next restore retries. It is inert by construction.
    }
  }
}
