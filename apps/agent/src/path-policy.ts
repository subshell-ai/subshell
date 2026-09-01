import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * The agent-side path allowlist (spec 2026-08-31 §7): `write_file` and
 * `remove_paths` are accepted only under <dataDir> or a tracked session's
 * launch cwd. Defense-in-depth against a compromised control plane — the
 * commands are signed, but signing proves WHO, not WHETHER.
 */

/** Realpath each root (symlinked roots must not smuggle an escape through the prefix test). */
export async function realpathRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await realpath(root));
    } catch {
      // A vanished root cannot authorize anything; drop it (tracked cwd deleted under a dead session).
    }
  }
  return out;
}

/** Deepest existing ancestor of `p`, realpath'd — a new file's parents may embed a symlink. */
async function realpathExisting(p: string): Promise<string | null> {
  let cur = p;
  for (;;) {
    try {
      return await realpath(cur);
    } catch {
      const parent = cur.lastIndexOf(sep);
      if (parent <= 0) return null;
      cur = cur.slice(0, parent);
    }
  }
}

/**
 * True when `rawPath` (existing or not) resolves inside one of the
 * `realpathRoots`-normalized `roots`. `..` segments are collapsed by
 * `resolve`; symlinked ancestors are caught via the ancestor walk.
 * @param rawPath - the path to gate, relative or absolute; never throws on denies.
 * @param roots - allowed roots; realpath'd here, so callers may pass raw paths.
 */
export async function pathAllowed(rawPath: string, roots: string[]): Promise<boolean> {
  const abs = resolve(rawPath);
  const resolved = await realpathExisting(abs);
  if (resolved === null) return false;
  const normalized = await realpathRoots(roots);
  return normalized.some((root) => resolved === root || resolved.startsWith(root + sep));
}
