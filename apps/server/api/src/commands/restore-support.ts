import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ServiceDeps } from "@/service.js";
import { restoreStagingRoot, type StageRecord } from "@/services/backup-staging.js";
import { isEncryptedBackup } from "@/services/backups/encryption.js";
import { instanceRestoreJournalPath } from "@/services/backups/journal.js";
import { assertSafeHostPath } from "@/services/backups/paths.js";
import type { InstancePaths, StagedInstanceBackup } from "@/services/backups/types.js";
import { resolveInstalledBinary } from "@/services/installed-binary.js";
import { instanceBackupPaths } from "@/services/instance-backup-source.js";
import { restoreChildEnv } from "./restore-system.js";

export { restoreInspectionDefaults } from "@/services/restore-inspection.js";

/** Inspecting an expired upload never deletes it; expiry cleanup belongs to boot/API. */
export function readLocalRestoreStage(id: string, allowExpired = false): StageRecord {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid restore identifier.");
  const dir = join(restoreStagingRoot(), id);
  const directory = lstatSync(dir);
  const metadata = join(dir, "stage.json");
  const file = lstatSync(metadata);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.size > 8 * 1024 * 1024 ||
    file.mode & 0o077 ||
    (process.getuid && (file.uid !== process.getuid() || directory.uid !== process.getuid()))
  )
    throw new Error("Restore upload is not a protected stage owned by this OS user.");
  const record = JSON.parse(readFileSync(metadata, "utf8")) as StageRecord;
  if (record.id !== id || !Number.isFinite(record.expiresAt)) throw new Error("Invalid restore metadata.");
  if (!allowExpired && record.expiresAt <= Date.now()) throw new Error("Restore upload expired. Upload it again.");
  return record;
}

/** Public stage summaries contain neither extraction paths nor credential material. */
export function publicStage(record: StageRecord) {
  const destination = record.destination ?? (record.prepared ? instanceBackupPaths() : undefined);
  const journalPath = destination
    ? instanceRestoreJournalPath(destination.configPath ? dirname(destination.configPath) : destination.dataDir)
    : undefined;
  return {
    id: record.id,
    expiresAt: record.expiresAt,
    prepared: record.prepared === true,
    choices: record.choices,
    destination,
    transactionId: record.prepared ? record.id : undefined,
    journalPath,
    recoveryUserId: record.recoveryUserId,
    manifest: record.stage.manifest,
    admins: record.stage.admins,
    legacyDatabaseOnly: record.stage.legacyDatabaseOnly,
  };
}

export function listPreparedRestoreStages(): ReturnType<typeof publicStage>[] {
  const root = restoreStagingRoot();
  if (!existsSync(root)) return [];
  const rows: ReturnType<typeof publicStage>[] = [];
  for (const id of readdirSync(root)) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    try {
      const path = join(root, id, "stage.json");
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.size > 8 * 1024 * 1024 ||
        (process.getuid && info.uid !== process.getuid()) ||
        info.mode & 0o077
      )
        continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as StageRecord;
      if (!raw.prepared || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= Date.now()) continue;
      rows.push(publicStage(readLocalRestoreStage(id)));
    } catch {
      /* incomplete, expired or foreign uploads are not offered */
    }
  }
  return rows.sort((a, b) => b.expiresAt - a.expiresAt);
}

export async function encrypted(path: string): Promise<boolean> {
  await assertSafeHostPath(path);
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(8);
    readSync(fd, prefix, 0, 8, 0);
    return isEncryptedBackup(prefix);
  } finally {
    closeSync(fd);
  }
}

export function describeArchive(stage: StagedInstanceBackup, log: (line: string) => void): void {
  log(
    `${stage.legacyDatabaseOnly ? "DATABASE-ONLY snapshot (no config, keys, plugins or logs)" : "FULL instance archive"}; captured ${stage.manifest.completedAt}; server ${stage.manifest.serverVersion}.`,
  );
  log(
    `Components: ${[...new Set(stage.manifest.entries.map((entry) => entry.path.split("/").slice(0, 2).join("/")))].join(", ")}.`,
  );
}

export async function boundedWait(
  ready: () => boolean,
  milliseconds: number,
  sleep: (ms: number) => Promise<void>,
  message: string,
): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!ready()) {
    if (Date.now() >= end) throw new Error(message);
    await sleep(100);
  }
}

export function startDetachedServer(
  configDir: string,
  destination: InstancePaths,
  legacy: boolean,
  service: ServiceDeps,
) {
  const resolved = resolveInstalledBinary({ configDir, platform: service.platform, home: service.home });
  let argv: string[];
  if (resolved.kind === "compiled") argv = [resolved.path];
  else if (resolved.kind === "source") argv = resolved.argv;
  else {
    const script = process.argv[1];
    if (!script || !/\.(?:ts|js)$/.test(script) || !existsSync(script))
      throw new Error("Cannot resolve a server executable to start. Restore with --no-start and start it explicitly.");
    argv = [process.execPath, resolve(script)];
  }
  const child = Bun.spawn({
    cmd: argv,
    cwd: configDir,
    env: restoreChildEnv(configDir, destination, legacy),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  return { pid: child.pid, stop: () => child.kill(), exited: () => child.exitCode !== null };
}
