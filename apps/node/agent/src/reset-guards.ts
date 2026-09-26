import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The shape guards a destructive chain runs BEFORE it consents or deletes,
 * the third pinned copy of the same words: the Rust original
 * (`crates/desktop-core/src/reset_guards.rs`), the control plane's CLI twin
 * (`apps/server/api/src/services/reset-guards.ts`), and this node-side one.
 * The words match on purpose; change one, change the others. Guards exist on
 * every chain that deletes, because the delete plan is assembled from ambient
 * constants and a mistyped data dir (`/`, `$HOME`) is a live `rm -rf` with a
 * nice message behind it.
 */

/** Whether `path` is safe to be a recursive delete target at all. */
export function pathRulesOk(path: string): boolean {
  if (!isAbsolute(path) || path === "/" || path.length < 2) return false;
  const home = homedir();
  // The home itself, and any spelling that resolves to it, is refused:
  // `resolve` is the TS twin of the Rust canonicalize-here (the directories
  // may not exist yet, so canonicalize is not available).
  if (path === home || resolve(path) === resolve(home)) return false;
  return true;
}

/** Whether `dir` contains `other` (or IS it), by resolved spelling. */
export function containsPath(dir: string, other: string): boolean {
  const rel = relative(resolve(dir), resolve(other));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether deleting `dir` recursively would swallow `kept` — the binary a
 * `reset` promised to survive. The Rust test that names `~/.local` as the
 * refused data dir for a binary at `~/.local/bin/subshell` is the case this
 * exists for.
 */
export function deleteGuardOk(dir: string, kept: string): boolean {
  return !containsPath(dir, kept);
}
