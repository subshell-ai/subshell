import { constants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { BackupLimits } from "./types.js";

/** Canonicalize only the OS temp root for internally generated paths (macOS /var is an alias). */
export function trustedTemporaryDirectory(): string {
  return realpathSync(tmpdir());
}

/** Only these server-owned components can enter or leave an instance archive. */
export const DATA_COMPONENTS = [
  "node-signing.json",
  "node-encryption.json",
  "vapid.json",
  "peers.json",
  "identities",
  "plugins",
  "plugins-state",
  "subshells",
  "logs",
] as const;

/** Explicit archive exclusions, independent of an operator's filesystem layout. */
export const EXCLUSIONS = [
  "backups",
  "staging",
  "restore/update transactions",
  "generated MCP launch state",
  "binary caches",
  "OS service definitions",
  "projects",
  "project uploads",
  "external credentials",
  "remote node files",
];

/** Default disk-based ceilings; tar and gzip payloads are streamed. */
export const DEFAULT_BACKUP_LIMITS: BackupLimits = {
  archiveBytes: 16 * 1024 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024 * 1024,
  files: 50_000,
};

/** Validate configurable disk ceilings; parser metadata has its own native 4 MiB bound. */
export function backupLimits(input: Partial<BackupLimits> = {}): BackupLimits {
  const result = { ...DEFAULT_BACKUP_LIMITS, ...input };
  for (const key of Object.keys(result) as (keyof BackupLimits)[]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) {
      throw new Error(`invalid backup limit: ${key}`);
    }
  }
  return result;
}

/** Reject traversal, platform-dependent names, and paths outside supported logical components. */
export function validateArchivePath(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    isAbsolute(path) ||
    /[\\:]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error("unsafe archive path");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("unsafe archive path");
  if (path === "manifest.json" || path === "database/instance.db" || path === "config/config.env") return;
  const component = parts[1];
  if (parts[0] !== "data" || !DATA_COMPONENTS.some((allowed) => component === allowed)) {
    throw new Error("unsupported archive component");
  }
  if (component?.endsWith(".json") && parts.length !== 2) throw new Error("invalid file component");
  if (parts.some((part) => part.startsWith(".tmp-") || part.startsWith(".old-"))) {
    throw new Error("archive contains plugin installation staging state");
  }
}

/** Validate every existing ancestor without dereferencing symlinks. */
export async function assertSafeHostPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(/[\\/]/)) {
    if (!part) continue;
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`symlink is not supported: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Creates a private directory and repairs existing permissions. */
export async function privateDirectory(path: string): Promise<void> {
  await assertSafeHostPath(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/** A missing optional component is absent; unreadable components fail the capture. */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Enumerate only regular files, refusing links/devices and interrupted plugin installations. */
export async function regularFiles(
  root: string,
  prefix: string,
  maxFiles = DEFAULT_BACKUP_LIMITS.files,
): Promise<{ source: string; path: string }[]> {
  await assertSafeHostPath(root);
  const result: { source: string; path: string }[] = [];
  async function visit(source: string, path: string): Promise<void> {
    validateArchivePath(path);
    const info = await lstat(source);
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort()) await visit(join(source, name), `${path}/${name}`);
    } else if (info.isFile()) {
      result.push({ source, path });
      if (result.length > maxFiles) throw new Error("backup file count exceeds limit");
    } else {
      throw new Error(`backup requires regular files: ${source}`);
    }
  }
  await visit(root, prefix);
  return result;
}

/** Copy exactly the observed length. Appends are excluded; truncation/replacement is an error. */
export async function captureFile(
  source: string,
  target: string,
  maxBytes: number,
  allowGrowing = false,
): Promise<number> {
  await assertSafeHostPath(source);
  await privateDirectory(dirname(target));
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await input.stat();
    if (!initial.isFile() || initial.size > maxBytes) throw new Error("backup file exceeds limit or is not regular");
    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < initial.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, initial.size - position), position);
        if (!bytesRead) throw new Error("backup source was truncated during capture");
        await output.writeFile(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await output.sync();
      const final = await input.stat();
      if (final.size < initial.size || (!allowGrowing && final.mtimeMs !== initial.mtimeMs)) {
        throw new Error("backup source changed during capture");
      }
    } finally {
      await output.close();
    }
    return initial.size;
  } finally {
    await input.close();
  }
}
