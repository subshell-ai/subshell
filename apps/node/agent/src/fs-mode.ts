import { chmod, stat } from "node:fs/promises";

/**
 * chmods `path` to `want` if any group/other bit crept in despite the mode
 * argument. Shared between the two modules that persist secrets (config.ts,
 * subshell-meta.ts): mkdir/writeFile modes apply only to the created leaf AND
 * are masked by umask, so every secret-bearing path needs this re-tightening
 * pass right after creation.
 * @param path - file or directory just created/rewritten.
 * @param want - the exact mode to force (e.g. 0o600, 0o700).
 */
export async function enforceMode(path: string, want: number): Promise<void> {
  const st = await stat(path);
  if ((st.mode & 0o077) !== 0) await chmod(path, want);
}
