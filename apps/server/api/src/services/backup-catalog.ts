import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertSafeHostPath } from "./backups/paths.js";

export interface LocalBackupFile {
  path: string;
  name: string;
  bytes: number;
  createdAt: string;
  legacyDatabaseOnly: boolean;
  encrypted: boolean;
  serverVersion?: string;
}

/** Read-only discovery in the instance backup store. Inspection still validates every selected file. */
export async function listLocalBackups(dataDir: string): Promise<LocalBackupFile[]> {
  const dir = resolve(dataDir, "backups");
  await assertSafeHostPath(dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: LocalBackupFile[] = [];
  for (const name of names) {
    const database = /^subshell-v(.+)-(\d{8})-(\d{6})(?:-\d+)?\.db$/.exec(name);
    const archive = /^subshell-update-v(.+)-\d{8}-\d{6}-[a-f0-9-]{36}\.tar\.gz$/.exec(name);
    const version = database?.[1] ?? archive?.[1];
    if (version && version.length > 256) continue;
    if (!database && !/\.(?:tar\.gz(?:\.enc)?|subshell)$/.test(name)) continue;
    const path = join(dir, name);
    if (path.length > 4096 || name.length > 512 || /[\r\n\0]/.test(name)) continue;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) continue;
      const date = database
        ? `${database[2]?.slice(0, 4)}-${database[2]?.slice(4, 6)}-${database[2]?.slice(6, 8)}T${database[3]?.slice(0, 2)}:${database[3]?.slice(2, 4)}:${database[3]?.slice(4, 6)}Z`
        : stat.mtime.toISOString();
      files.push({
        path,
        name,
        bytes: stat.size,
        createdAt: Number.isNaN(Date.parse(date)) ? stat.mtime.toISOString() : new Date(date).toISOString(),
        legacyDatabaseOnly: !!database,
        encrypted: name.endsWith(".enc"),
        ...(version && { serverVersion: version }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files
    .sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name, undefined, { numeric: true }),
    )
    .slice(0, 500);
}
