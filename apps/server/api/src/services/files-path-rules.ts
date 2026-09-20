import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { dirAllowed, dirNavigable } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { FavoritesRepository } from "@/db/repositories/favorites.repository.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { loadNodeAccess, nodeCanManageFor } from "@/lib/node-access.js";

/**
 * The path rules the folder picker and its saved-shortcut lists share —
 * extracted from `files.route.ts` (2026-09-20) so the REMOTE browse can
 * filter its per-node Recent/Favorites with the SAME rules the local route
 * applies, rather than a second copy. Behavior-identical to the route-local
 * originals; the long comments came with the code.
 */

/**
 * The optional confinement root, or `null` when `SUBSHELL_FS_ROOT` is unset —
 * which means NO confinement (any absolute path is allowed). This is
 * documented behavior, not a missing allowlist: the folder picker exists to
 * reach arbitrary directories on the host (see the route docstring).
 *
 * Realpath-resolved when possible: a root reached through a symlink confines
 * by its REAL location, which is what {@link isAllowedRoot} compares every
 * candidate's realpath against. When the root itself cannot be resolved (it
 * does not exist) the lexical form is kept — nothing under it can exist
 * either, so the candidate-side realpath check refuses everything anyway.
 */
function confinementRoot(): { lexical: string; real: string } | null {
  const root = process.env.SUBSHELL_FS_ROOT?.trim();
  if (!root) return null;
  const lexical = resolve(root);
  try {
    return { lexical, real: realpathSync(lexical) };
  } catch {
    return { lexical, real: lexical };
  }
}

/**
 * True when `path` is `root` or lives beneath it.
 * @param path - Absolute candidate path
 * @param root - Absolute root to test against
 * @returns Whether the candidate is the root or inside it
 */
function isWithin(path: string, root: string): boolean {
  // `root + sep` would be "//" for a root of "/", matching nothing and
  // refusing the entire filesystem the operator just opened up. Comparison is
  // deliberately case-SENSITIVE: it matches how the kernel resolves the
  // realpath this is checked against, and a case-insensitive test would let
  // `/Root/x` pass a `/root` confinement on a case-insensitive volume.
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(prefix);
}

/**
 * Confinement check. With `SUBSHELL_FS_ROOT` set, BOTH path forms must be inside
 * the root: the lexical one (cheap reject for `..` escapes and strangers) and
 * the symlink-resolved one — entries are stat'ed through symlinks, so
 * comparing unresolved paths alone let a planted symlinked dir enumerate its
 * target anywhere on the host (final review M-2).
 *
 * A candidate whose realpath fails is split honestly: a path that exists in
 * some form (including a BROKEN symlink — the link is present, the target is
 * not) cannot be proven confined and is refused; a path with no presence at
 * all cannot list anything, so it passes through to the normal 404. Unset
 * confinement keeps the exact old behavior: anything absolute is allowed.
 */
/**
 * @param opts.navigation - use the WIDER `dirNavigable` test (inside a rule,
 *   or an ancestor of one) instead of the strict `dirAllowed`. Pass it only
 *   for BROWSING a directory: an ancestor has to stay listable or there is no
 *   way down to the rule. Everything that names a directory to LAUNCH or
 *   shortcut into — `/favorite`, the recents and favorites filters — stays
 *   strict, because offering a shortcut to a directory no subshell can be
 *   created in is a dead click.
 */
export function isAllowedRoot(
  path: string,
  allowedDirs: readonly string[] = [],
  opts: { navigation?: boolean } = {},
): boolean {
  if (!isAbsolute(path)) return false;
  // The LOCAL node's directory allowlist (spec 2026-09-05), layered on top of
  // SUBSHELL_FS_ROOT: both must pass. They answer different questions — the
  // env root is the operator's instance-wide "show nothing outside this tree",
  // the allowlist is the node owner's "subshells may only run under these" —
  // and a path has to satisfy whichever are in force.
  const inScope = opts.navigation ? dirNavigable : dirAllowed;
  const resolved = resolve(path);
  // Cheap lexical reject first.
  if (!inScope(resolved, allowedDirs)) return false;

  // Then the SAME test against the symlink-resolved form, and — this is the
  // part that was wrong — BEFORE the `SUBSHELL_FS_ROOT` early return, not
  // after it. With no confinement root configured (the default) the function
  // used to return here, leaving the allowlist lexical-only: a symlink under
  // an allowed root would list whatever it pointed at to a constrained user.
  // A disclosure rather than an execution hole (launching is gated
  // separately, and the node realpaths both sides), but a real one.
  let real: string | null = null;
  try {
    real = realpathSync(resolved);
  } catch {
    real = null; // absent or a broken symlink — handled per-branch below
  }
  if (real !== null && allowedDirs.length > 0 && !inScope(real, allowedDirs)) return false;

  const root = confinementRoot();
  if (!root) return true; // no SUBSHELL_FS_ROOT → host FS is browsable by design
  // The cheap reject compares LIKE WITH LIKE. Testing an unresolved candidate
  // against the realpath-resolved root refused the root itself whenever the
  // root is reached through a symlink — on macOS `/tmp` IS a symlink to
  // `/private/tmp`, so `SUBSHELL_FS_ROOT=/tmp/x` 403'd every path including
  // `/tmp/x`, locking the operator out of the directory they configured.
  // Either spelling may pass here; the realpath comparison below is the
  // security boundary and is unchanged.
  if (!isWithin(resolved, root.lexical) && !isWithin(resolved, root.real)) return false;
  if (real !== null) return isWithin(real, root.real);
  try {
    lstatSync(resolved); // a present-but-unresolvable path (broken symlink)
    return false; // cannot prove where it leads → refuse
  } catch {
    return true; // nothing exists at this path → nothing to leak, 404 next
  }
}

/**
 * The allowlist to FILTER a picker listing by, for one caller and node.
 *
 * Empty (no filtering) whenever the caller can MANAGE the node, because that
 * is the person who defines the rules: they browse in order to choose what to
 * permit, and scoping their view to the rules already in force would make the
 * second rule unaddable — the first one would have hidden everywhere else.
 * Anyone else sees only what they could actually launch in, since offering a
 * directory whose only outcome is a refusal is pure friction.
 *
 * This is a UX filter, NOT the security boundary. The boundary is the launch
 * gate, applied on the control plane (`assertDirAllowed`) and independently on
 * the node — neither of which cares who is browsing.
 */
export async function launchScopeFor(userId: string, nodeId: string): Promise<string[]> {
  const dirs = await new NodeAllowedDirsRepository(db).listForNode(nodeId);
  if (dirs.length === 0) return dirs;
  const { row, access } = await loadNodeAccess(
    {
      nodes: new NodesRepository(db),
      shares: new NodeSharesRepository(db),
      userMeta: new UserMetaRepository(db),
    },
    userId,
    nodeId,
  );
  if (!row) return dirs;
  const isAdmin = (await new UserMetaRepository(db).getRole(userId)) === "admin";
  return nodeCanManageFor(row.kind, access, isAdmin) ? [] : dirs;
}

/**
 * Recently used paths for ONE node (default: the control-plane host),
 * filtered to whatever the current confinement allows. The confinement filter
 * rides remote-node scopes too — conservative by design: `SUBSHELL_FS_ROOT` is
 * the operator's "show me nothing outside this tree" switch, and a remote
 * path is still just a path string this picker can never cd into anyway.
 */
export async function recentPathsFor(userId: string, nodeId = LOCAL_NODE_ID) {
  const repo = new RecentPathsRepository(db);
  const all = await repo.listByUser(userId, 20, nodeId);
  // Node-scoped: a recent path is filtered by THAT node's rules, so a row
  // saved before a rule tightened stops being offered as a shortcut.
  const allowedDirs = await launchScopeFor(userId, nodeId);
  return all.filter((r) => isAllowedRoot(r.path, allowedDirs));
}

/**
 * Starred directories ON ONE NODE (default: the control-plane host),
 * confinement-filtered the same way — a favorite saved before
 * `SUBSHELL_FS_ROOT` was set must not leak out of the root either. Favorites
 * are node-scoped since migration 0034, exactly like recents: a starred path
 * is a claim about one machine's filesystem, so a Box row answers to Box's
 * rules and never appears in the local panel.
 */
export async function favoritePathsFor(userId: string, nodeId = LOCAL_NODE_ID) {
  const repo = new FavoritesRepository(db);
  const all = await repo.listByUser(userId, "directory", nodeId);
  // A favorite saved before a rule tightened must not leak past it either —
  // and since 0034 the rules consulted are THAT node's, the same
  // per-node-scope rule `recentPathsFor` applies.
  const allowedDirs = await launchScopeFor(userId, nodeId);
  return all.filter((f) => isAllowedRoot(f.ref, allowedDirs)).map(({ ref, label }) => ({ path: ref, label }));
}
