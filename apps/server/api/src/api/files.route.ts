import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { dirAllowed, dirNavigable } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { FavoritesRepository } from "@/db/repositories/favorites.repository.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { loadNodeAccess, nodeCanManageFor } from "@/lib/node-access.js";
import { exploreNodeDirectory } from "@/services/files-remote-browse.service.js";
import { expandTilde } from "@/utils/path.js";

interface DirEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** One saved-directory row shared by the Recent and Favorites sections. */
const SavedPathSchema = t.Object({
  path: t.String({ description: "Absolute directory path" }),
  label: t.Union([t.String(), t.Null()], { description: "Optional display label" }),
});

const ExploreResponseSchema = t.Object({
  path: t.String({ description: "Resolved directory" }),
  parent: t.Union([t.String({ description: "Parent dir" }), t.Null()]),
  entries: t.Array(
    t.Object({
      name: t.String(),
      path: t.String(),
      kind: t.Union([t.Literal("dir"), t.Literal("file")]),
    }),
    { description: "Direct children" },
  ),
  recent: t.Array(SavedPathSchema, { description: "Three most recently used paths, favorites excluded" }),
  favorites: t.Array(SavedPathSchema, { description: "Starred paths, newest first" }),
});

const FavoriteBodySchema = t.Object({
  path: t.String({ minLength: 1, description: "Directory to star/unstar" }),
  favorite: t.Boolean({ description: "true = star, false = unstar" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

const RecentResponseSchema = t.Object({
  paths: t.Array(
    t.Object({
      path: t.String({ description: "Absolute directory path" }),
      label: t.Union([t.String(), t.Null()], { description: "Optional display label" }),
    }),
    { description: "Recently used working directories, newest first" },
  ),
});

/**
 * Filesystem exploration for the folder picker (new subshell form).
 *
 * **This is an authenticated-browser folder picker, not a sandbox.** With no
 * `node` param it browses the control-plane host; with one it dispatches a
 * signed `fs_ls` to that node's agent and browses THERE — on either machine
 * that is the entire point of the feature, so the real security boundary is
 * the OS user's filesystem permissions: anything the backend's user (local)
 * or the agent's user (node) can read is browsable. What this route does
 * control:
 *
 * - **Browser-only**: machine credentials (subshell keys, system keys) get
 *   403. A running harness holding its own bearer token must not be able to
 *   enumerate the operator's disk; only a signed-in human in the browser
 *   uses the picker (verified: the MCP server never calls this route).
 * - **Node visibility**: a `node` id the caller cannot see answers 404,
 *   never 403 — the same no-oracle rule `/recent` applies (spec 2026-08-31 §2).
 * - **Optional confinement (LOCAL ONLY)**: `SUBSHELL_FS_ROOT`, when set,
 *   restricts browsing to that directory tree (paths outside it get 403).
 *   It NEVER confines a remote node — that root belongs to this host and
 *   means nothing on another machine; a node's own confinement is the agent
 *   user's filesystem permissions. When unset — the default — there is no
 *   path confinement anywhere. There is no secret allowlist.
 * - One level per request, dotfiles hidden, absolute paths only (on a node,
 *   an omitted/`~` path means the AGENT's home — the server cannot expand
 *   `~` against a filesystem it cannot see).
 * - **Feature gate**: browsing a node needs `fs_ls`, i.e. the agent's
 *   the exact node protocol (any mismatch is refused at `ready`). An agent
 *   that answers `unsupported` anyway surfaces as 409 `NODE_OUTDATED`.
 * - `PATCH /favorite` stars/unstars a path (the picker's Favorites section —
 *   the successor to the removed bookmarks feature); local `/explore` ships
 *   both sections so the panel needs one request per folder. Remote
 *   `/explore` ships them EMPTY — recents/favorites are control-plane
 *   concepts and node paths there would be dead clicks (per-node recents
 *   ride `/recent?node=` for the form's pre-fill).
 */
export const filesRoutes = new Elysia({ prefix: "/api/files" })
  .use(authGuard)
  .get(
    "/explore",
    async ({ query, user, actor }) => {
      // Cookie-only by design — see the route docstring. Machine credentials
      // (bearer subshell keys / system keys) are rejected outright: filesystem
      // browsing is a human-in-the-browser affordance, not a harness API.
      if (actor !== "cookie") {
        throw new FilesError("forbidden", "Folder browsing is restricted to browser sessions", 403);
      }

      // Omitted/'local' → the byte-identical control-plane browse below. Any
      // other id is a REMOTE browse: same response shape, but the directory
      // walk happens on the node via one signed `fs_ls` round-trip (and the
      // visibility check, feature gate, and error mapping ride with it —
      // see `files-remote-browse.service.ts`).
      const nodeId = query.node?.trim() || LOCAL_NODE_ID;
      if (nodeId !== LOCAL_NODE_ID) {
        return await exploreNodeDirectory(user.id, nodeId, query.path);
      }

      // `?? ""`, not `|| homedir()`: the empty case has to stay distinguishable
      // here so the landing directory below can differ from home. (It was
      // `|| homedir()`, which made the fallback dead code — `raw` was never
      // falsy, so a restricted picker 403'd on first open with no way back.)
      const raw = query.path?.trim() ?? "";
      // The local node's directory allowlist, read once for the whole request
      // (the gate, the recents filter and the favorites filter all consult it).
      const allowedDirs = await launchScopeFor(user.id, LOCAL_NODE_ID);
      // Where an unspecified browse LANDS. Home is the natural default and
      // usually outside the rules, so with rules in force the picker opens on
      // the first one instead of on a 403 the user cannot navigate out of.
      const landing =
        allowedDirs.length > 0 && !dirNavigable(homedir(), allowedDirs) ? (allowedDirs[0] ?? homedir()) : homedir();
      // An explicit `~` still means HOME, and is refused honestly if home is
      // out of bounds — only the UNSPECIFIED case is redirected.
      const path = raw === "" ? landing : expandTilde(raw, homedir());

      // Navigable, not allowed: an ancestor of a rule must remain listable or
      // there is no way DOWN to the rule. Its ENTRIES are filtered below, and
      // launching is gated separately and strictly.
      if (!isAllowedRoot(path, allowedDirs, { navigation: true })) {
        throw new FilesError("forbidden", "Path outside allowed roots", 403);
      }

      let resolved: string;
      try {
        resolved = resolve(path);
        // Navigation mode again — the pair must agree, or the resolved form
        // rejects the ancestor the raw form just admitted.
        if (!isAllowedRoot(resolved, allowedDirs, { navigation: true })) {
          throw new FilesError("forbidden", "Path outside allowed roots", 403);
        }
      } catch (err) {
        if (err instanceof FilesError) throw err;
        throw new FilesError("invalid", "Invalid path", 400);
      }

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(resolved);
      } catch {
        throw new FilesError("not_found", "Path does not exist", 404);
      }

      const entries: DirEntry[] = [];
      if (stat.isDirectory()) {
        try {
          for (const name of readdirSync(resolved)) {
            if (name.startsWith(".")) continue;
            const full = join(resolved, name);
            let kind: DirEntry["kind"];
            try {
              const s = statSync(full);
              if (s.isDirectory()) kind = "dir";
              else if (s.isFile()) kind = "file";
              else continue;
            } catch {
              continue;
            }
            entries.push({ name, path: full, kind });
          }
        } catch {
          throw new FilesError("unreadable", "Directory is not readable", 403);
        }
      }

      // Entries a restricted caller could never use are hidden, but ancestors
      // of a rule stay so the tree can be walked down to it. Directories only —
      // a FILE under an allowed root is fine, one outside it is noise.
      const visible = allowedDirs.length === 0 ? entries : entries.filter((e) => dirNavigable(e.path, allowedDirs));

      const parent = resolved === "/" ? null : join(resolved, "..");
      // Both sections in one response so the picker needs one request per
      // folder. A path is listed once — favorites win over recents.
      // These sections are the LOCAL browse's own: a remote explore ships
      // them empty (see exploreNode), so nothing here can be a dead click
      // into a filesystem this response is not walking. Per-node recents
      // live on /recent?node=<id> instead.
      const favorites = await favoritePaths(user.id);
      const starred = new Set(favorites.map((f) => f.path));
      const recent = (await recentPaths(user.id))
        .filter((r) => !starred.has(r.path))
        .slice(0, 3)
        .map(({ path: p, label }) => ({ path: p, label }));
      return { path: resolved, parent, entries: visible, recent, favorites } as const;
    },
    {
      query: t.Object({
        path: t.Optional(t.String({ description: "Directory to list (defaults to home)" })),
        node: t.Optional(
          t.String({
            description:
              "Node id to browse; omitted or 'local' = the control-plane host. A remote browse relays the agent's own refusals: 409 NODE_OUTDATED, NODE_OFFLINE or NODE_UNREACHABLE",
          }),
        ),
      }),
      response: ExploreResponseSchema,
      detail: {
        operationId: "exploreFiles",
        tags: ["files"],
        description: "Lists a directory on this host or a node (folder picker; browser sessions only)",
      },
    },
  )
  .get(
    "/recent",
    async ({ user, actor, query }) => {
      // Browser-only, like /explore: this pre-fills the new-subshell form —
      // a human-in-the-browser affordance, not a harness API.
      if (actor !== "cookie") {
        throw new FilesError("forbidden", "Recent paths are restricted to browser sessions", 403);
      }
      const nodeId = query.node?.trim() || LOCAL_NODE_ID;
      // Omitted/'local' needs no visibility check — own local recents are
      // one's own, and the response stays byte-identical to the pre-nodes
      // behavior. Any other id must be a node the caller can SEE: the same
      // rule the profile pin applies (spec 2026-08-31 §6.2) — absent and
      // invisible collapse to one 404, never 403, so node ids cannot be
      // probed through the recents list.
      if (nodeId !== LOCAL_NODE_ID) {
        const { access } = await loadNodeAccess(
          {
            nodes: new NodesRepository(db),
            shares: new NodeSharesRepository(db),
            userMeta: new UserMetaRepository(db),
          },
          user.id,
          nodeId,
        );
        if (access === "none") {
          throw new FilesError("not_found", "Node not found", 404);
        }
      }
      const paths = (await recentPaths(user.id, nodeId)).map(({ path, label }) => ({ path, label }));
      return { paths } as const;
    },
    {
      query: t.Object({
        node: t.Optional(
          t.String({
            description: "Node id to scope the list to; omitted or 'local' = the control-plane host",
          }),
        ),
      }),
      // Just the 200 schema, like /explore: the error bodies are the
      // global handler's structured shape, which this route adds nothing to.
      response: RecentResponseSchema,
      detail: {
        operationId: "recentFilePaths",
        tags: ["files"],
        description: "Lists recently used working directories for one node (browser sessions only)",
      },
    },
  )
  .patch(
    "/favorite",
    async ({ body, user, actor }) => {
      // Browser-only, like its siblings: starring is a picker affordance.
      if (actor !== "cookie") {
        throw new FilesError("forbidden", "Favoriting paths is restricted to browser sessions", 403);
      }
      const path = body.path.trim();
      if (!path) {
        throw new FilesError("invalid", "Path is required", 400);
      }
      const resolved = resolve(expandTilde(path, homedir()));
      // Starring is a local-path affordance, so `local`'s rules gate it too —
      // otherwise a favorite could be created that the picker then filters
      // straight back out, which reads as the star silently failing.
      const allowedDirs = await launchScopeFor(user.id, LOCAL_NODE_ID);
      if (!isAllowedRoot(resolved, allowedDirs)) {
        throw new FilesError("forbidden", "Path outside allowed roots", 403);
      }
      await new FavoritesRepository(db).setFavorite(user.id, "directory", resolved, body.favorite);
      return { ok: true } as const;
    },
    {
      body: FavoriteBodySchema,
      // 200 only: a bad/forbidden path throws FilesError, which the global
      // handler renders as the standard ApiErrorResponse.
      response: { 200: OkResponseSchema },
      detail: {
        operationId: "setPathFavorite",
        tags: ["files"],
        description: "Star or unstar a directory for the folder picker (browser sessions only)",
      },
    },
  );

/**
 * Route-local error. `status` is what the error handler (and Elysia's native
 * mapping) turns into the HTTP code — per-route classes must carry it, or a
 * "forbidden" would surface as a 500.
 */
class FilesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "FilesError";
  }
}

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
function isAllowedRoot(
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
async function launchScopeFor(userId: string, nodeId: string): Promise<string[]> {
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
async function recentPaths(userId: string, nodeId = LOCAL_NODE_ID) {
  const repo = new RecentPathsRepository(db);
  const all = await repo.listByUser(userId, 20, nodeId);
  // Node-scoped: a recent path is filtered by THAT node's rules, so a row
  // saved before a rule tightened stops being offered as a shortcut.
  const allowedDirs = await launchScopeFor(userId, nodeId);
  return all.filter((r) => isAllowedRoot(r.path, allowedDirs));
}

/**
 * Starred directories, confinement-filtered the same way — a favorite saved
 * before `SUBSHELL_FS_ROOT` was set must not leak out of the root either.
 */
async function favoritePaths(userId: string) {
  const repo = new FavoritesRepository(db);
  const all = await repo.listByUser(userId, "directory");
  // Favorites are control-plane (local) paths, so they answer to `local`'s
  // rules — a star saved before a rule tightened must not leak past it either.
  const allowedDirs = await launchScopeFor(userId, LOCAL_NODE_ID);
  return all.filter((f) => isAllowedRoot(f.ref, allowedDirs)).map(({ ref, label }) => ({ path: ref, label }));
}
