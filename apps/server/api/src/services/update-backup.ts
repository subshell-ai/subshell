import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SUBSHELL_DB_BACKUPS_KEEP } from "@/constants.js";
import { SERVER_VERSION } from "@/version.js";
import { beginBackupCapture } from "./backup-capture-lock.js";
import { createInstanceBackup } from "./backups/archive.js";
import { syncRestoreDirectory } from "./backups/journal.js";
import { assertSafeHostPath } from "./backups/paths.js";
import type { InstancePaths } from "./backups/types.js";
import { listUpdateArchives } from "./db-backup.js";
import { instanceBackupConfig, instanceBackupPaths } from "./instance-backup-source.js";

/** Full pre-upgrade archive plus an internal checkpoint for synchronous crash rollback. */
export async function createUpdateBackup(
  input: {
    source?: InstancePaths;
    effectiveConfig?: Record<string, string>;
    keep?: number;
    capture?: () => () => void;
  } = {},
): Promise<{ path: string; rollbackDatabase: string } | null> {
  const source = input.source ?? instanceBackupPaths();
  try {
    await stat(source.databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const dir = resolve(source.dataDir, "backups");
  const checkpointDir = resolve(source.dataDir, "update", "checkpoints");
  await assertSafeHostPath(dir);
  await assertSafeHostPath(checkpointDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
  await chmod(checkpointDir, 0o700);
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15).replace("T", "-");
  const id = crypto.randomUUID();
  const path = join(dir, `subshell-update-v${SERVER_VERSION}-${stamp}-${id}.tar.gz`);
  const rollbackDatabase = join(checkpointDir, `${id}.db`);
  const release = (input.capture ?? beginBackupCapture)();
  try {
    await createInstanceBackup({
      source,
      destinationPath: path,
      effectiveConfig: input.effectiveConfig ?? instanceBackupConfig(),
      onDatabaseSnapshot: async (snapshot) => {
        await copyFile(snapshot, rollbackDatabase, constants.COPYFILE_EXCL);
        await chmod(rollbackDatabase, 0o600);
        const handle = await open(rollbackDatabase, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        syncRestoreDirectory(checkpointDir);
      },
    });
    const keep = input.keep ?? SUBSHELL_DB_BACKUPS_KEEP;
    const pinned = new Set([path]);
    for (const name of ["pending.json", "failed.json"]) {
      try {
        const text = await readFile(join(source.dataDir, "update", name), "utf8");
        if (text.length > 64 * 1024) throw new Error("update marker exceeds limit");
        const marker = JSON.parse(text);
        const retained = marker.archiveBackup ?? marker.backup;
        if (typeof retained === "string") pinned.add(retained);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // This family's OWN retention: database snapshots in the same directory
    // are pruned by backupDatabase's count, never here.
    if (keep > 0)
      for (const old of listUpdateArchives(dir)
        .filter((file) => !pinned.has(file.path))
        .slice(Math.max(0, keep - 1))) {
        await rm(old.path, { force: true });
        const checkpoint = /-([a-f0-9-]{36})\.tar\.gz$/.exec(old.path);
        if (checkpoint) await rm(join(checkpointDir, `${checkpoint[1]}.db`), { force: true });
      }
    return { path, rollbackDatabase };
  } catch (error) {
    await rm(path, { force: true });
    await rm(rollbackDatabase, { force: true });
    throw error;
  } finally {
    release();
  }
}
