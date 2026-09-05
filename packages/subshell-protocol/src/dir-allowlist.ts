/**
 * The node directory allowlist — which directories a node will launch
 * subshells in (spec 2026-09-05).
 *
 * A node grants arbitrary command execution under its OS user to anyone who
 * can launch there, and **any** node share confers that. The allowlist is how
 * an owner says "on this machine, only under these directories".
 *
 * This module is the SHARED, PURE half: normalization and a lexical subtree
 * test, used by the control plane (to gate creation), the node (as a first
 * pass) and the browser (to preview and explain). No `node:` imports — the
 * barrel this is exported from is consumed by the mobile app through Metro,
 * which cannot resolve them, and by the agent binary.
 *
 * **Lexical is necessary but not sufficient.** `resolve()`-collapse is
 * symlink-blind: `/root/link/../evil` collapses to `/root/evil` (inside the
 * root) while the kernel opens `/outside/evil` through `link`. So:
 *
 * - `..` is REFUSED here rather than collapsed, in both entries and
 *   candidates — a rule that looks like it confines and does not is worse
 *   than no rule.
 * - The authority for a real launch is the filesystem-aware check: the node's
 *   `pathAllowed()` (`apps/client/src/path-policy.ts`), which walks symlinked
 *   ancestors and denies dangling leaves; and on the control plane, the
 *   already-`realpath`'d value that `validateWorkingDir` returns. Callers MUST
 *   test the RESOLVED path, never raw user input.
 */

/** Path separator. Hardcoded: these paths are POSIX by contract (linux/darwin nodes). */
const SEP = "/";

/**
 * Upper bound on entries per node.
 *
 * The whole set is pushed to the node on every change and every reconnect, so
 * it is a wire payload, not just a table. A cap keeps that bounded and a
 * runaway UI from writing thousands of rows.
 */
export const MAX_ALLOWED_DIRS = 64;

/**
 * Canonical form of one allowlist entry, or `null` when the input cannot be
 * one.
 *
 * Refuses: relative paths (an entry has no cwd to resolve against), `.` and
 * `..` segments (see the module note), and empty input. Collapses duplicate
 * separators and strips the trailing slash so `/a` and `/a/` are one rule.
 *
 * @param raw - operator-supplied path
 * @returns the normalized absolute path, or null if it is not a valid entry
 */
export function normalizeAllowedDir(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(SEP)) return null;
  const segments = trimmed.split(SEP).filter((segment) => segment.length > 0);
  // `.`/`..` are refused, not resolved. A dotfile NAME (".config") is fine.
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.length === 0 ? SEP : SEP + segments.join(SEP);
}

/**
 * True when `child` is `parent` or lies beneath it.
 *
 * The `+ SEP` is what stops `/home/theo` from swallowing `/home/theodore` —
 * a bare `startsWith` is the classic prefix bug here.
 */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return parent === SEP ? child.startsWith(SEP) : child.startsWith(parent + SEP);
}

/**
 * Normalizes a whole set: drops invalid entries, dedupes, removes entries
 * already covered by a broader one, sorts, and caps at
 * {@link MAX_ALLOWED_DIRS}.
 *
 * Redundant entries are dropped rather than kept because the list is shown to
 * an operator as the rules in force — listing `/home/theo/projects` beneath
 * `/home/theo` displays a rule that constrains nothing.
 *
 * Invalid entries are dropped rather than throwing: the API layer validates
 * and reports separately, and every other consumer (the node applying a
 * pushed list, the UI rendering one) needs a total function.
 */
export function normalizeAllowedDirs(raw: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const entry of raw) {
    const dir = normalizeAllowedDir(entry);
    if (dir !== null && !normalized.includes(dir)) normalized.push(dir);
  }
  // Shortest first, so a broader entry is always seen before what it covers.
  normalized.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const dir of normalized) {
    if (!kept.some((root) => isUnder(dir, root))) kept.push(dir);
  }
  return kept.sort((a, b) => a.localeCompare(b)).slice(0, MAX_ALLOWED_DIRS);
}

/**
 * Whether `candidate` is inside one of `roots` — the lexical test.
 *
 * An EMPTY `roots` means unrestricted. That is the backwards-compatible
 * default every node starts with, and it mirrors what an unset
 * `SUBSHELL_FS_ROOT` means: no rule, not "deny everything".
 *
 * Read the module note before using this as a security decision on a raw
 * path: it does not resolve symlinks, and it is only sound on a path the
 * caller has already resolved.
 *
 * @param candidate - an absolute, already-resolved path
 * @param roots - normalized allowlist entries; empty = unrestricted
 */
export function dirAllowed(candidate: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const path = normalizeAllowedDir(candidate);
  // A candidate that cannot be normalized (relative, or carrying `..`) is
  // refused: with rules in force, anything unverifiable is outside them.
  if (path === null) return false;
  return roots.some((root) => {
    const normalizedRoot = normalizeAllowedDir(root);
    return normalizedRoot !== null && isUnder(path, normalizedRoot);
  });
}

/**
 * Whether a picker may LIST `candidate` — inside a root, or an ancestor of
 * one.
 *
 * Distinct from {@link dirAllowed}, and the distinction is what makes a
 * restricted picker usable. `dirAllowed` is a descendant test, so with a rule
 * of `/home/theo/projects` it answers false for `/home/theo` — an ancestor —
 * and a picker filtered by it alone shows an empty, unnavigable panel with no
 * way DOWN to the very directory that is permitted. Ancestors have to stay
 * visible as stepping stones.
 *
 * This is a NAVIGATION predicate, never an authorization one. Listing a
 * directory is not launching in it: `dirAllowed` (control plane) and
 * `pathAllowed` (node) remain the gates, and both are descendant tests.
 *
 * @param candidate - an absolute path
 * @param roots - normalized allowlist entries; empty = unrestricted
 */
export function dirNavigable(candidate: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const path = normalizeAllowedDir(candidate);
  if (path === null) return false;
  return roots.some((root) => {
    // Both sides normalized: an entry or a node-supplied path carrying a
    // trailing slash or a doubled separator must not slip past either
    // direction of the test.
    const normalizedRoot = normalizeAllowedDir(root);
    if (normalizedRoot === null) return false;
    return isUnder(path, normalizedRoot) || isUnder(normalizedRoot, path);
  });
}
