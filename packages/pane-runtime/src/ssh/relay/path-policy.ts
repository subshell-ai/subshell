import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * The agent-side path allowlist (spec 2026-08-31 §7): `write_file` and
 * `remove_paths` are accepted only under <dataDir> or a tracked subshell's
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
      // A vanished root cannot authorize anything; drop it (tracked cwd deleted under a dead subshell).
    }
  }
  return out;
}

/** True when the raw input carries a `..` path segment (the literal `..`, a leading `../`, or any interior one). */
function hasDotDotSegment(raw: string): boolean {
  return raw.split(sep).includes("..");
}

/** Deepest existing ancestor of `p`, realpath'd — a new file's parents may embed a symlink. */
async function realpathExisting(p: string): Promise<string | null> {
  let cur = p;
  for (;;) {
    try {
      return await realpath(cur);
    } catch {
      const parent = cur.lastIndexOf(sep);
      if (parent <= 0) return null; // stop never probes `/` itself — fail-closed, deliberate
      cur = cur.slice(0, parent);
    }
  }
}

/**
 * True when `rawPath` (existing or not) resolves inside one of the
 * `realpathRoots`-normalized `roots`. `..` segments are refused outright —
 * spec §7 says so, and resolve()-collapse is symlink-blind: `/root/l/../evil`
 * collapses to `/root/evil` (inside) while the kernel opens `/outside/evil`
 * through `l → /outside`. Symlinked ancestors are caught via the ancestor
 * walk; a symlink LEAF is denied by lstat (a dangling one would otherwise
 * pass the walk and be followed by a later open(O_CREAT)).
 * @param rawPath - the path to gate, relative or absolute; never throws on denies.
 * @param roots - allowed roots; realpath'd here, so callers may pass raw paths.
 */
export async function pathAllowed(rawPath: string, roots: string[]): Promise<boolean> {
  if (hasDotDotSegment(rawPath)) return false;
  const abs = resolve(rawPath);
  try {
    // Any leaf symlink is denied outright: an existing target is caught by
    // realpath's first iteration anyway, and a dangling one is not (see above).
    if ((await lstat(abs)).isSymbolicLink()) return false;
  } catch {
    // Leaf doesn't exist yet — fine; the ancestor walk covers its parents.
  }
  const resolved = await realpathExisting(abs);
  if (resolved === null) return false;
  const normalized = await realpathRoots(roots);
  return normalized.some((root) => resolved === root || resolved.startsWith(root + sep));
}
