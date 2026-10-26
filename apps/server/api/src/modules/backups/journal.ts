// Pre-config recovery must have no path to constants, config-env, auth, or server startup.
import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DATA_COMPONENTS } from "./paths.js";
import type { InstancePaths } from "./types.js";

export interface Replacement {
  /** Logical component. */
  component: string;
  /** Caller-selected live path. */
  target: string;
  /** Sibling containing previous state. */
  previous: string;
  /** Prepared replacement sibling. */
  next: string;
  /** Whether the original exists. */
  originalExists: boolean;
  /** Whether the backup has this component. */
  replacementExists: boolean;
}
export interface RestoreJournal {
  /** Journal contract. */
  version: 1;
  /** Unique local replacement ID. */
  transactionId: string;
  /** Durable transaction phase. */
  phase: "preparing" | "applying" | "pending-boot" | "rolling-back" | "finalizing";
  /** Caller-owned destination map. */
  destination: InstancePaths;
  /** Deterministic logical replacement set. */
  replacements: Replacement[];
}

function safePath(path: string): void {
  const absolute = resolve(path);
  // Refuse a symlink at the target itself or at the directory that holds it:
  // those are the components a crafted restore could repoint at a protected
  // file. Components ABOVE that directory are left alone — a legitimate
  // filesystem symlinks an ancestor (macOS `/var → /private/var`, `/tmp`, a bind
  // mount), and walking from `/` refused those, so the server aborted at boot
  // for every path under one (measured: the darwin release smoke died here). The
  // local OS user who could plant a link in an ancestor is out of the threat
  // model; the journal's own dir is app-created, but its ancestors need not be.
  for (const component of [absolute, dirname(absolute)]) {
    try {
      if (lstatSync(component).isSymbolicLink()) throw new Error("symlink in restore journal path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Flush a containing directory after publishing or removing transaction state. */
export function syncRestoreDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Default journal beside config.env, so recovery can happen before config is loaded. */
export function instanceRestoreJournalPath(configDir: string): string {
  return join(resolve(configDir), "restore-journal.json");
}

/** The last transaction's durable outcome distinguishes successful boot from automatic rollback. */
export interface InstanceRestoreResult {
  transactionId: string;
  outcome: "completed" | "rolled-back";
  completedAt: string;
}

export function readInstanceRestoreResult(journalPath: string): InstanceRestoreResult | null {
  const path = join(dirname(resolve(journalPath)), "restore-result.json");
  safePath(path);
  if (!existsSync(path)) return null;
  if (lstatSync(path).size > 1024) throw new Error("restore result is too large");
  const result = JSON.parse(readFileSync(path, "utf8")) as InstanceRestoreResult;
  if (
    !/^[a-f0-9-]{36}$/.test(result.transactionId) ||
    !["completed", "rolled-back"].includes(result.outcome) ||
    !Number.isFinite(Date.parse(result.completedAt))
  )
    throw new Error("invalid restore result");
  return result;
}

function writeRestoreResult(
  journalPath: string,
  journal: RestoreJournal,
  outcome: InstanceRestoreResult["outcome"],
): void {
  const path = join(dirname(resolve(journalPath)), "restore-result.json");
  const temporary = `${path}.writing-${journal.transactionId}`;
  safePath(path);
  safePath(temporary);
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({ transactionId: journal.transactionId, outcome, completedAt: new Date().toISOString() }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncRestoreDirectory(dirname(path));
}

/** Deterministic destinations used both for preparation and journal validation. */
export function replacementsFor(destination: InstancePaths, transactionId: string, legacy: boolean): Replacement[] {
  const targets = [{ component: "database", target: resolve(destination.databasePath) }];
  if (!legacy) {
    if (!destination.configPath) throw new Error("full instance restore requires an explicit config destination");
    targets.push({ component: "config", target: resolve(destination.configPath) });
    for (const component of DATA_COMPONENTS)
      targets.push({ component, target: join(resolve(destination.dataDir), component) });
  }
  for (const a of targets)
    for (const b of targets) {
      if (a !== b && (a.target === b.target || a.target.startsWith(`${b.target}/`)))
        throw new Error("restore component destinations overlap");
    }
  return targets.map(({ component, target }) => ({
    component,
    target,
    previous: `${target}.restore-old-${transactionId}`,
    next: `${target}.restore-new-${transactionId}`,
    originalExists: false,
    replacementExists: false,
  }));
}

/** Publish a fully written, flushed journal atomically, refusing an existing initial transaction. */
export function writeRestoreJournalSync(path: string, journal: RestoreJournal, initial = false): void {
  const temporary = `${path}.writing-${journal.transactionId}`;
  // Guard both names, like writeRestoreResult does; `"wx"` already refuses to
  // open through a symlink, but the symmetric check removes the "is this a bug?"
  // double-take and refuses a symlinked journal dir outright.
  safePath(path);
  safePath(temporary);
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(journal));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (initial) {
    try {
      linkSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } else {
    renameSync(temporary, path);
  }
  syncRestoreDirectory(dirname(path));
}

function readJournal(path: string): RestoreJournal | null {
  safePath(path);
  if (!existsSync(path)) return null;
  if (lstatSync(path).size > 64 * 1024) throw new Error("restore journal is too large");
  const journal = JSON.parse(readFileSync(path, "utf8")) as RestoreJournal;
  if (
    journal.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(journal.transactionId) ||
    !["preparing", "applying", "pending-boot", "rolling-back", "finalizing"].includes(journal.phase) ||
    !journal.destination ||
    !Array.isArray(journal.replacements) ||
    !isAbsolute(journal.destination.databasePath) ||
    !isAbsolute(journal.destination.dataDir) ||
    (journal.destination.configPath !== undefined && !isAbsolute(journal.destination.configPath))
  )
    throw new Error("invalid restore journal");
  const expected = replacementsFor(journal.destination, journal.transactionId, journal.replacements.length === 1);
  if (journal.replacements.length !== expected.length) throw new Error("invalid restore journal components");
  for (const [index, item] of journal.replacements.entries()) {
    const valid = expected[index];
    if (
      !valid ||
      item.component !== valid.component ||
      item.target !== valid.target ||
      item.next !== valid.next ||
      item.previous !== valid.previous ||
      typeof item.originalExists !== "boolean" ||
      typeof item.replacementExists !== "boolean"
    ) {
      throw new Error("invalid restore journal paths");
    }
    safePath(item.target);
    safePath(item.next);
    safePath(item.previous);
  }
  return journal;
}

/** A serving process may confirm only the destination it actually opened. */
export function assertInstanceRestoreDestination(path: string, actual: InstancePaths): void {
  const journal = readJournal(path);
  if (!journal) return;
  if (resolve(actual.databasePath) !== journal.destination.databasePath) {
    throw new Error("restore boot database does not match the pending destination");
  }
  if (
    journal.replacements.length > 1 &&
    (resolve(actual.dataDir) !== journal.destination.dataDir ||
      !actual.configPath ||
      resolve(actual.configPath) !== journal.destination.configPath)
  ) {
    throw new Error("restore boot paths do not match the pending destination");
  }
}

function discardDatabaseSidecars(path: string): void {
  const sidecars = ["-journal", "-wal", "-shm"].map((suffix) => `${path}${suffix}`);
  for (const sidecar of sidecars) safePath(sidecar);
  if (existsSync(path)) {
    const db = new Database(path);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      // Recover the existing main's hot journal before deleting it; never replay it onto previous.
      db.query("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
      db.exec("BEGIN EXCLUSIVE; COMMIT");
      const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (result.busy) throw new Error("database is busy; stop the server before restore recovery");
    } finally {
      db.close();
    }
  }
  for (const sidecar of sidecars) rmSync(sidecar, { force: true });
}

/**
 * Remove a file and, for SQLite databases, the sidecar names that can exist
 * beside it. The prepared replacement is written with real transactions
 * before the swap, so a process killed mid-apply can leave `<next>-wal`,
 * `-shm` and `-journal` behind a main file that rollback already removed —
 * staged session and config state, invisible to every later listing.
 */
function removeFileAndSidecars(path: string): void {
  rmSync(path, { recursive: true, force: true });
  for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** Synchronous failed-boot/interrupted-apply rollback, safe before config-env is evaluated. */
export function rollbackInstanceRestoreSync(path: string): void {
  const journal = readJournal(path);
  if (!journal) return;
  if (journal.phase === "finalizing") throw new Error("restore has already been finalized");
  const wasPreparing = journal.phase === "preparing";
  journal.phase = "rolling-back";
  writeRestoreJournalSync(path, journal);
  for (const item of [...journal.replacements].reverse()) {
    const previousExists = existsSync(item.previous);
    const installedNew = !wasPreparing && item.replacementExists && !existsSync(item.next);
    if (previousExists || (!item.originalExists && installedNew)) {
      if (item.component === "database") discardDatabaseSidecars(item.target);
      // Keep a service's EnvironmentFile continuously present during rollback as well.
      if (item.component !== "config" || !previousExists) rmSync(item.target, { recursive: true, force: true });
      if (previousExists) {
        renameSync(item.previous, item.target);
        // POSIX rename is a no-op when config preservation left both names on the same inode.
        rmSync(item.previous, { recursive: true, force: true });
      }
      syncRestoreDirectory(dirname(item.target));
    }
    removeFileAndSidecars(item.next);
  }
  writeRestoreResult(path, journal, "rolled-back");
  rmSync(path, { force: true });
  rmSync(`${path}.writing-${journal.transactionId}`, { force: true });
  syncRestoreDirectory(dirname(path));
}

/** Synchronous successful-boot commit; once finalizing begins, recovery finishes cleanup. */
export function finalizeInstanceRestoreSync(path: string): void {
  const journal = readJournal(path);
  if (!journal) return;
  if (journal.phase !== "pending-boot" && journal.phase !== "finalizing")
    throw new Error("restore is not ready to finalize");
  journal.phase = "finalizing";
  writeRestoreJournalSync(path, journal);
  for (const item of journal.replacements) {
    rmSync(item.previous, { recursive: true, force: true });
    removeFileAndSidecars(item.next);
    syncRestoreDirectory(dirname(item.target));
  }
  writeRestoreResult(path, journal, "completed");
  rmSync(path, { force: true });
  rmSync(`${path}.writing-${journal.transactionId}`, { force: true });
  syncRestoreDirectory(dirname(path));
}

/** Before config load, undo interrupted replacement or finish interrupted commit cleanup. */
export function recoverInstanceRestoreSync(path: string): "none" | "pending-boot" | "rolled-back" | "finalized" {
  const journal = readJournal(path);
  if (!journal) return "none";
  if (journal.phase === "pending-boot") return "pending-boot";
  if (journal.phase === "finalizing") {
    finalizeInstanceRestoreSync(path);
    return "finalized";
  }
  rollbackInstanceRestoreSync(path);
  return "rolled-back";
}
