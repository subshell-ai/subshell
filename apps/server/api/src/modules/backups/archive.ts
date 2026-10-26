import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backupEncryptionPasswordProblem } from "@internal/subshell-protocol";
import { SERVER_VERSION } from "../../version.js";
import { captureConfig, serializeConfig } from "./config.js";
import { inspectDatabase, requiredIdentityPaths, snapshotDatabase, validateMigrations } from "./database.js";
import { decryptArchive, encryptArchive, isEncryptedBackup } from "./encryption.js";
import { syncRestoreDirectory } from "./journal.js";
import {
  assertSafeHostPath,
  backupLimits,
  captureFile,
  DATA_COMPONENTS,
  EXCLUSIONS,
  exists,
  privateDirectory,
  regularFiles,
  trustedTemporaryDirectory,
  validateArchivePath,
} from "./paths.js";
import { readInstanceTar, writeInstanceTar } from "./tar.js";
import type {
  BackupEntry,
  BackupInspection,
  BackupLimits,
  CreateInstanceBackupOptions,
  InstanceBackupManifest,
  StagedInstanceBackup,
} from "./types.js";

/** Stream a digest without loading a captured file into JS memory. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Make one new versioned archive; SQLite is atomic, logs are captured over the recorded interval. */
export async function createInstanceBackup(options: CreateInstanceBackupOptions): Promise<{
  path: string;
  bytes: number;
  manifest: InstanceBackupManifest;
}> {
  if (options.password !== undefined) {
    const problem = backupEncryptionPasswordProblem(options.password);
    if (problem) throw new Error(problem);
  }
  const limits = backupLimits(options.limits);
  const destination = resolve(options.destinationPath);
  for (const component of DATA_COMPONENTS) {
    const captured = join(resolve(options.source.dataDir), component);
    if (destination === captured || destination.startsWith(`${captured}/`))
      throw new Error("backup destination overlaps a captured component");
  }
  await assertSafeHostPath(destination);
  if (await exists(destination)) throw new Error("backup destination already exists");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(destination), ".backup-capture-"));
  await chmod(staging, 0o700);
  const startedAt = new Date().toISOString();
  try {
    const dbPath = join(staging, "database", "instance.db");
    await privateDirectory(dirname(dbPath));
    await snapshotDatabase(options.source.databasePath, dbPath);
    const { migrations } = inspectDatabase(dbPath);
    for (const path of requiredIdentityPaths(dbPath)) {
      const sourcePath = join(options.source.dataDir, path.slice("data/".length));
      if (!(await exists(sourcePath))) throw new Error(`backup is missing required identity: ${path}`);
    }
    if (options.source.configPath) await assertSafeHostPath(options.source.configPath);
    if (options.source.configPath && (await exists(options.source.configPath))) {
      const configInfo = await lstat(options.source.configPath);
      if (!configInfo.isFile() || configInfo.size > 1024 * 1024)
        throw new Error("backup configuration exceeds limit or is not regular");
    }
    const stored =
      options.source.configPath && (await exists(options.source.configPath))
        ? await readFile(options.source.configPath, "utf8")
        : "";
    const config = captureConfig(stored, {
      ...options.effectiveConfig,
      DATABASE_PATH: resolve(options.source.databasePath),
      SUBSHELL_SERVER_DATA_DIR: resolve(options.source.dataDir),
    });
    const configPath = join(staging, "config", "config.env");
    await privateDirectory(dirname(configPath));
    await writeFile(configPath, serializeConfig(config), { mode: 0o600, flag: "wx" });
    const paths = ["database/instance.db", "config/config.env"];
    let totalBytes = (await stat(dbPath)).size + (await stat(configPath)).size;
    for (const component of DATA_COMPONENTS) {
      const root = join(options.source.dataDir, component);
      if (!(await exists(root))) continue;
      for (const file of await regularFiles(root, `data/${component}`, limits.files)) {
        if (paths.length >= limits.files) throw new Error("backup file count exceeds limit");
        totalBytes += await captureFile(
          file.source,
          join(staging, file.path),
          limits.fileBytes,
          component === "logs" || component === "subshells",
        );
        if (totalBytes + paths.length * 1024 > limits.expandedBytes)
          throw new Error("backup expanded bytes exceed limit");
        paths.push(file.path);
      }
    }
    const entries: BackupEntry[] = [];
    for (const path of paths.sort()) {
      const file = join(staging, path);
      const size = (await stat(file)).size;
      if (size > limits.fileBytes) throw new Error("backup file exceeds limit");
      entries.push({ path, bytes: size, sha256: await hashFile(file) });
    }
    const manifest: InstanceBackupManifest = {
      format: "subshell-instance",
      version: 1,
      sourcePaths: {
        databasePath: resolve(options.source.databasePath),
        dataDir: resolve(options.source.dataDir),
        ...(options.source.configPath ? { configPath: resolve(options.source.configPath) } : {}),
      },
      serverVersion: SERVER_VERSION,
      startedAt,
      completedAt: new Date().toISOString(),
      migrations,
      consistency: "sqlite-snapshot-logs-over-interval",
      entries,
      exclusions: EXCLUSIONS,
    };
    const plain = join(staging, "archive.tar.gz");
    await writeInstanceTar(plain, staging, manifest, limits);
    await chmod(plain, 0o600);
    let output = plain;
    if (options.password !== undefined) {
      output = join(staging, "archive.encrypted");
      await encryptArchive(plain, output, options.password);
    }
    const bytes = (await stat(output)).size;
    if (bytes > limits.archiveBytes) throw new Error("backup archive bytes exceed limit");
    if (totalBytes + paths.length * 1024 > limits.expandedBytes) throw new Error("backup expanded bytes exceed limit");
    const handle = await open(output, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Same-filesystem hard link is an atomic, no-clobber publication of the completed file.
    await options.onDatabaseSnapshot?.(dbPath);
    await link(output, destination);
    syncRestoreDirectory(dirname(destination));
    return { path: destination, bytes, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function validateManifest(value: unknown, limits: BackupLimits): InstanceBackupManifest {
  if (typeof value !== "object" || !value || Array.isArray(value)) throw new Error("invalid backup manifest");
  const manifest = value as InstanceBackupManifest;
  if (manifest.format !== "subshell-instance" || manifest.version !== 1) throw new Error("unsupported backup version");
  if (
    typeof manifest.serverVersion !== "string" ||
    manifest.serverVersion.length > 100 ||
    !Number.isFinite(Date.parse(manifest.startedAt)) ||
    !Number.isFinite(Date.parse(manifest.completedAt)) ||
    manifest.consistency !== "sqlite-snapshot-logs-over-interval" ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.migrations) ||
    !Array.isArray(manifest.exclusions) ||
    manifest.exclusions.some((item) => typeof item !== "string")
  )
    throw new Error("invalid backup manifest");
  if (manifest.sourcePaths !== undefined) {
    const source = manifest.sourcePaths;
    if (
      !source ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      ![source.databasePath, source.dataDir].every(
        (path) => typeof path === "string" && path.length > 0 && path.length <= 4096 && !/[\r\n\0]/.test(path),
      ) ||
      (source.configPath !== undefined &&
        (typeof source.configPath !== "string" ||
          !source.configPath ||
          source.configPath.length > 4096 ||
          /[\r\n\0]/.test(source.configPath)))
    )
      throw new Error("invalid backup source locations");
  }
  if (manifest.entries.length > limits.files) throw new Error("backup file count exceeds limit");
  validateMigrations(manifest.migrations);
  let total = 0;
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > limits.fileBytes ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("invalid backup entry");
    }
    validateArchivePath(entry.path);
    if (entry.path === "manifest.json" || paths.has(entry.path)) throw new Error("duplicate backup entry");
    paths.add(entry.path);
    total += entry.bytes;
    if (total > limits.expandedBytes) throw new Error("backup expanded bytes exceed limit");
  }
  if (!paths.has("database/instance.db") || !paths.has("config/config.env"))
    throw new Error("backup is missing a required component");
  return manifest;
}

/** Validate all bytes and materialize regular files only in private staging. Optional limits are stricter ceilings. */
export async function stageInstanceBackup(
  path: string,
  password?: string,
  stagingDir?: string,
  inputLimits?: Partial<BackupLimits>,
): Promise<StagedInstanceBackup> {
  const limits = backupLimits(inputLimits);
  await assertSafeHostPath(path);
  const source = await lstat(path);
  if (!source.isFile() || source.size > limits.archiveBytes)
    throw new Error("backup archive bytes exceed limit or source is not regular");
  const parent = stagingDir === undefined ? trustedTemporaryDirectory() : resolve(stagingDir);
  await assertSafeHostPath(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, "subshell-restore-"));
  await chmod(dir, 0o700);
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const prefix = Buffer.alloc(16);
    const handle = await open(path, "r");
    try {
      await handle.read(prefix, 0, prefix.length, 0);
    } finally {
      await handle.close();
    }
    const databasePath = join(dir, "database", "instance.db");
    if (prefix.toString("utf8") === "SQLite format 3\x00") {
      if (!path.endsWith(".db")) throw new Error("legacy database-only backups must have a .db extension");
      await privateDirectory(dirname(databasePath));
      // An active/hot rollback journal can hold the committed pages while the main file contains
      // spilled, uncommitted pages. Reject every sidecar, including dangling symlinks (lstat).
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (await exists(`${path}${suffix}`))
          throw new Error("legacy backup must be a standalone database without SQLite sidecars");
      }
      const bytes = await captureFile(path, databasePath, limits.fileBytes);
      const inspected = inspectDatabase(databasePath);
      const at = source.mtime.toISOString();
      const manifest: InstanceBackupManifest = {
        format: "subshell-instance",
        version: 1,
        serverVersion: "legacy",
        startedAt: at,
        completedAt: at,
        migrations: inspected.migrations,
        consistency: "legacy-database-only",
        entries: [{ path: "database/instance.db", bytes, sha256: await hashFile(databasePath) }],
        exclusions: EXCLUSIONS,
      };
      return { dir, databasePath, manifest, admins: inspected.admins, legacyDatabaseOnly: true, cleanup };
    }
    let compressedPath = path;
    if (isEncryptedBackup(prefix)) {
      compressedPath = join(dir, ".authenticated.tar.gz");
      await decryptArchive(path, compressedPath, password);
    }
    const extracted = await readInstanceTar(compressedPath, dir, limits);
    const manifest = validateManifest(extracted.manifest, limits);
    if (extracted.entries.size !== manifest.entries.length) throw new Error("archive files disagree with manifest");
    for (const expected of manifest.entries) {
      const entry = extracted.entries.get(expected.path);
      if (!entry || entry.bytes !== expected.bytes) throw new Error("backup component missing or size mismatch");
      if (entry.sha256 !== expected.sha256) throw new Error("backup component checksum mismatch");
    }
    const inspected = inspectDatabase(databasePath);
    for (const path of requiredIdentityPaths(databasePath)) {
      if (!extracted.entries.has(path)) throw new Error(`backup is missing required identity: ${path}`);
    }
    if (JSON.stringify(inspected.migrations) !== JSON.stringify(manifest.migrations))
      throw new Error("backup database migration history disagrees with manifest");
    captureConfig(await readFile(join(dir, "config", "config.env"), "utf8"));
    if (compressedPath !== path) await rm(compressedPath);
    return { dir, databasePath, manifest, admins: inspected.admins, legacyDatabaseOnly: false, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Inspect a backup without leaking payload configuration, keys, or password hashes. */
export async function inspectInstanceBackup(path: string, password?: string): Promise<BackupInspection> {
  const staged = await stageInstanceBackup(path, password);
  try {
    return { manifest: staged.manifest, admins: staged.admins, legacyDatabaseOnly: staged.legacyDatabaseOnly };
  } finally {
    await staged.cleanup();
  }
}
