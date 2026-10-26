import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { restoreConfig, validateRestoreConfigOverrides } from "./config.js";
import { checkpointDatabase, inspectDatabase } from "./database.js";
import {
  finalizeInstanceRestoreSync,
  instanceRestoreJournalPath,
  type RestoreJournal,
  readInstanceRestoreResult,
  recoverInstanceRestoreSync,
  replacementsFor,
  rollbackInstanceRestoreSync,
  syncRestoreDirectory,
  writeRestoreJournalSync,
} from "./journal.js";
import { inspectSqliteSchema, readBackupMetadataJson, requireMetadataColumns } from "./metadata.js";
import {
  assertSafeHostPath,
  captureFile,
  DEFAULT_BACKUP_LIMITS,
  exists,
  privateDirectory,
  regularFiles,
} from "./paths.js";
import type { InstancePaths, RestoreInstanceBackupOptions, StagedInstanceBackup } from "./types.js";

async function copyComponent(source: string, next: string, component: string): Promise<void> {
  if ((await lstat(source)).isFile()) {
    await captureFile(source, next, DEFAULT_BACKUP_LIMITS.fileBytes);
    return;
  }
  await privateDirectory(next);
  for (const file of await regularFiles(source, `data/${component}`)) {
    const suffix = file.path.slice(`data/${component}/`.length);
    await captureFile(file.source, join(next, suffix), DEFAULT_BACKUP_LIMITS.fileBytes);
  }
}

async function flushPreparedComponent(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await flushPreparedComponent(join(path, name));
    syncRestoreDirectory(path);
  } else {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function disableNetworkPublication(journal: RestoreJournal): Promise<void> {
  const state = journal.replacements.find((item) => item.component === "plugins-state");
  const plugins = journal.replacements.find((item) => item.component === "plugins");
  const ids = new Set<string>();
  if (state?.replacementExists) {
    for (const id of await readdir(state.next)) {
      const file = join(state.next, id, "network.json");
      if (!(await exists(file))) continue;
      const value = await readBackupMetadataJson(file);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid network plugin state");
      const networkRecord = value as Record<string, unknown>;
      networkRecord.published = false;
      networkRecord.port = null;
      networkRecord.addresses = [];
      delete networkRecord.publishedAt;
      await writeFile(file, JSON.stringify(networkRecord), { mode: 0o600 });
      ids.add(id);
    }
  }
  if (plugins?.replacementExists) {
    for (const id of await readdir(plugins.next)) {
      if (!(await lstat(join(plugins.next, id))).isDirectory()) continue;
      const file = join(plugins.next, id, "package.json");
      if (!(await exists(file))) continue;
      const value = await readBackupMetadataJson(file);
      if (
        value &&
        typeof value === "object" &&
        (value as { subshell?: { type?: string } }).subshell?.type === "network"
      )
        ids.add(id);
    }
  }
  if (!ids.size) return;
  const database = journal.replacements[0];
  if (!database) throw new Error("missing restore database");
  const db = new Database(database.next);
  try {
    const schema = inspectSqliteSchema(db);
    requireMetadataColumns(schema, "plugin_state", ["plugin_id", "enabled", "updated_at"]);
    if (!schema.has("plugin_state")) {
      throw new Error("backup network plugins require plugin_state migration");
    }
    db.transaction(() => {
      for (const id of ids)
        db.query(
          "INSERT INTO plugin_state(plugin_id, enabled, updated_at) VALUES (?, 0, ?) ON CONFLICT(plugin_id) DO UPDATE SET enabled=0, updated_at=excluded.updated_at",
        ).run(id, new Date().toISOString());
    })();
  } finally {
    db.close();
  }
}

function revokeHumanSessions(path: string): void {
  const db = new Database(path);
  try {
    const schema = inspectSqliteSchema(db);
    if (schema.has("session")) db.exec('DELETE FROM "session"');
  } finally {
    db.close();
  }
}

/** Replace explicit components offline, retaining originals until boot succeeds. Never starts or stops a service. */
export async function restoreInstanceBackup(
  staged: StagedInstanceBackup,
  options: RestoreInstanceBackupOptions,
): Promise<{
  transactionId: string;
  journalPath: string;
}> {
  validateRestoreConfigOverrides(options.configOverrides ?? {});
  const destination: InstancePaths = {
    databasePath: resolve(options.destination.databasePath),
    dataDir: resolve(options.destination.dataDir),
    configPath: options.destination.configPath ? resolve(options.destination.configPath) : undefined,
  };
  const journalPath = resolve(
    options.journalPath ??
      instanceRestoreJournalPath(destination.configPath ? dirname(destination.configPath) : destination.dataDir),
  );
  const transactionId = options.transactionId ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(transactionId))
    throw new Error("Invalid reserved restore transaction identifier.");
  // A previously consumed stage must never make an old receipt confirm a new application.
  if (options.transactionId && readInstanceRestoreResult(journalPath)?.transactionId === transactionId)
    throw new Error("This prepared restore transaction was already consumed; prepare another archive.");
  const journal: RestoreJournal = {
    version: 1,
    transactionId,
    phase: "preparing",
    destination,
    replacements: replacementsFor(destination, transactionId, staged.legacyDatabaseOnly),
  };
  await assertSafeHostPath(journalPath);
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  for (const item of journal.replacements) {
    if (journalPath === item.target || journalPath.startsWith(`${item.target}/`))
      throw new Error("restore journal overlaps a restored component");
    if (item.target.startsWith(`${resolve(staged.dir)}/`) || resolve(staged.dir).startsWith(`${item.target}/`))
      throw new Error("restore destination overlaps staging");
    await assertSafeHostPath(item.target);
    await mkdir(dirname(item.target), { recursive: true, mode: 0o700 });
    item.originalExists = await exists(item.target);
  }
  // Validates intentional staged DB edits (e.g. temporary admin recovery), without requiring its old digest.
  await assertSafeHostPath(staged.databasePath);
  inspectDatabase(staged.databasePath);
  writeRestoreJournalSync(journalPath, journal, true);
  try {
    for (const item of journal.replacements) {
      const source =
        item.component === "database"
          ? staged.databasePath
          : item.component === "config"
            ? join(staged.dir, "config", "config.env")
            : join(staged.dir, "data", item.component);
      item.replacementExists = await exists(source);
      if (item.replacementExists) await copyComponent(source, item.next, item.component);
      if (item.component === "config") {
        const config = restoreConfig(await readFile(item.next, "utf8"), destination, options.configOverrides);
        await writeFile(item.next, config, { mode: 0o600 });
      }
    }
    const preparedDatabase = journal.replacements.find((item) => item.component === "database");
    if (!preparedDatabase) throw new Error("missing prepared restore database");
    revokeHumanSessions(preparedDatabase.next);
    if (options.mode === "migration" && !staged.legacyDatabaseOnly) await disableNetworkPublication(journal);
    // Flush prepared state before any original is moved.
    for (const item of journal.replacements) {
      if (!item.replacementExists) continue;
      await flushPreparedComponent(item.next);
      syncRestoreDirectory(dirname(item.next));
    }
    await checkpointDatabase(destination.databasePath);
    journal.phase = "applying";
    writeRestoreJournalSync(journalPath, journal);
    for (const item of journal.replacements) {
      if (item.originalExists) {
        if (item.component === "config") {
          // EnvironmentFile must remain present so a service can boot into interrupted-apply recovery.
          // An atomic hard link preserves a complete original; an interrupted file copy would not.
          if (!(await lstat(item.target)).isFile()) throw new Error("restore config destination is not regular");
          await link(item.target, item.previous);
          await flushPreparedComponent(item.previous);
          syncRestoreDirectory(dirname(item.previous));
        } else {
          await rename(item.target, item.previous);
        }
      }
      if (item.replacementExists) await rename(item.next, item.target);
      syncRestoreDirectory(dirname(item.target));
      await options.afterReplace?.(item.component);
    }
    journal.phase = "pending-boot";
    writeRestoreJournalSync(journalPath, journal);
    return { transactionId, journalPath };
  } catch (error) {
    await rollbackInstanceRestore(journalPath);
    throw error;
  }
}

/** Roll back failed boot or interrupted replacement; synchronous recovery is also available before config load. */
export async function rollbackInstanceRestore(path: string): Promise<void> {
  rollbackInstanceRestoreSync(path);
}

/** Finalize only after successful boot. */
export async function finalizeInstanceRestore(path: string): Promise<void> {
  finalizeInstanceRestoreSync(path);
}

/** Recover interrupted replacement before opening the instance database. */
export async function recoverInstanceRestore(
  path: string,
): Promise<"none" | "pending-boot" | "rolled-back" | "finalized"> {
  return recoverInstanceRestoreSync(path);
}
