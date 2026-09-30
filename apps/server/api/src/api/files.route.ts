import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { dirAllowed, dirNavigable } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { IS_TEST } from "@/constants.js";
import { db } from "@/db/index.js";
import { FavoritesRepository } from "@/db/repositories/favorites.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { loadNodeAccess } from "@/lib/node-access.js";
import {
  favoritePathsFor,
  isAllowedRoot,
  launchScopeFor,
  recentPathsFor,
  sortDirEntries,
} from "@/services/files-path-rules.js";
import { exploreNodeDirectory } from "@/services/files-remote-browse.service.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { FsDeadlineError, withFsDeadline } from "@/utils/fs-deadline.js";
import { expandTilde } from "@/utils/path.js";

interface DirEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** The one directory read `/explore` performs, so a test can make it fail. */
type ReaddirFn = (path: string) => Promise<string[]>;

let readdir: ReaddirFn = (path) => readdirAsync(path);

/**
 * Test seam for the ONE `readdir` the local browse performs. A refused
 * listing (macOS TCC, or plain unix modes) cannot be produced with `chmod` in
 * this suite — CI runs as root, which ignores permission bits — so the error
 * is injected here instead. Passing `null` restores the real call. Same
 * hard refusal as `setHasUsersProbeForTests`: a mis-wired production import
 * must not be able to replace the filesystem under the folder picker.
 *
 * Async because the read moved off the event loop (see `utils/fs-deadline`): a
 * synchronous `readdir` of a directory on a hung mount parked the WHOLE server,
 * so the seam — and the injected errno a test throws through it — is a promise.
 * @internal
 */
export function setFilesReaddirForTests(fn: ReaddirFn | null): void {
  if (!IS_TEST) throw new Error("setFilesReaddirForTests is a test-only seam");
  readdir = fn ?? ((path) => readdirAsync(path));
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
  // One union of the two "could not list it" reasons. No description on the
  // union node itself: `t.Optional(t.Union([...], {…}))` reads back as REQUIRED
  // through Elysia's type map, which would drop the (blocked-less) remote
  // explore shape out of this route's response type.
  blocked: t.Optional(
    t.Union([
      t.Literal("permission", {
        description:
          "The OS refused to list THIS directory (macOS Files-and-Folders, or unix modes): entries is empty because the read failed, not because the folder is",
      }),
      t.Literal("timeout", {
        description:
          "The read did not answer within the deadline (a hung network/automount is the usual cause). entries is empty, but the directory may well exist and answer later. Absent on a genuinely empty directory",
      }),
    ]),
  ),
});

const FavoriteBodySchema = t.Object({
  path: t.String({ minLength: 1, description: "Directory to star/unstar" }),
  favorite: t.Boolean({ description: "true = star, false = unstar" }),
  node: t.Optional(
    t.String({
      description:
        "Machine the path lives on; omitted or 'local' = the control-plane host. A node id the caller cannot see answers 404, never 403 (the same no-oracle rule /explore and /recent apply)",
    }),
  ),
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
  home: t.Nullable(
    t.String({
      description:
        "Home directory on the node this list is scoped to, for pre-filling a working directory when there are no recents; null when the node has not reported one, or when it lies outside the rules this caller launches under",
    }),
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
 * - `PATCH /favorite` stars/unstars a path ON THE MACHINE BEING BROWSED
 *   (`node`, default `local`) — the picker's Favorites section, the successor
 *   to the removed bookmarks feature. Both saved-shortcut sections ride
 *   `/explore` on EITHER transport, scoped to the browsed machine: a Recent
 *   or favorite of node X appears only while the panel walks node X, which
 *   is what retired the older design that shipped them EMPTY remotely (a
 *   machine-scoped star is no longer a dead click in another machine's
 *   panel, so the star is offered there too — 2026-09-20).
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

      // `resolve` is lexical (no filesystem), so the path and its parent are
      // known before anything is touched — a refused or timed-out browse still
      // answers with them, which is how the picker offers a way back OUT.
      let resolved: string;
      try {
        resolved = resolve(path);
      } catch {
        throw new FilesError("invalid", "Invalid path", 400);
      }
      const parent = resolved === "/" ? null : join(resolved, "..");

      const entries: DirEntry[] = [];
      // Why THIS directory could not be listed, when the request itself
      // succeeded: `"permission"` (the OS refused the read — macOS TCC or unix
      // modes) or `"timeout"` (the read never answered within
      // `FS_READ_TIMEOUT_MS`, the hung-mount signature). Reported rather than
      // thrown because the folder exists and the person can act; the response
      // still carries parent/recent/favorites so there is a way to a good path.
      let blocked: "permission" | "timeout" | undefined;

      try {
        // Navigable, not allowed: an ancestor of a rule must remain listable or
        // there is no way DOWN to the rule. Its ENTRIES are filtered below, and
        // launching is gated separately and strictly. The gate may itself do a
        // realpath (a restricted caller, symlinked path); a timeout there is a
        // browse we cannot vouch for, reported as blocked rather than a 500.
        const inRoots =
          (await isAllowedRoot(path, allowedDirs, { navigation: true })) &&
          (await isAllowedRoot(resolved, allowedDirs, { navigation: true }));
        if (!inRoots) {
          throw new FilesError("forbidden", "Path outside allowed roots", 403);
        }

        let isDirectory = false;
        try {
          isDirectory = (await withFsDeadline(() => statAsync(resolved))).isDirectory();
        } catch (err) {
          if (err instanceof FsDeadlineError) blocked = "timeout";
          // A stat failure other than a timeout means the path is not there to
          // the OS user — the same honest 404 the synchronous version threw for
          // any `statSync` catch (a directory whose parent denies the traverse,
          // a path that vanished mid-walk).
          else throw new FilesError("not_found", "Path does not exist", 404);
        }

        if (blocked === undefined && isDirectory) {
          let names: string[] = [];
          try {
            names = await withFsDeadline(() => readdir(resolved));
          } catch (err) {
            if (err instanceof FsDeadlineError) blocked = "timeout";
            else {
              // macOS asks per protected folder (Desktop, Documents, Downloads)
              // the first time one is listed, and a decline makes this reject
              // EPERM from then on; unix modes reject EACCES. Neither is a
              // broken request — the picker shows the folder as blocked and
              // offers the way to fix it (spec 2026-09-14 §5.3). Any other
              // errno still 403s.
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== "EPERM" && code !== "EACCES") {
                throw new FilesError("unreadable", "Directory is not readable", 403);
              }
              blocked = "permission";
            }
          }
          if (blocked === undefined) {
            // One `stat` per child (never a `readdir` — that is the act that
            // fires a macOS prompt per folder under ~ on first open). Statted
            // CONCURRENTLY, off the event loop, all under one deadline: the
            // listing is trustworthy only if EVERY child answered, so a mount
            // that hangs a child fails the whole read to `timeout` and clears
            // the partial entries rather than shipping a folder that looks
            // half-empty. A child that merely errors (a raced death, an
            // unreadable mode) is skipped, exactly as the sync loop did.
            try {
              await withFsDeadline(async () => {
                await Promise.all(
                  names.map(async (name) => {
                    if (name.startsWith(".")) return;
                    const full = join(resolved, name);
                    try {
                      const s = await statAsync(full);
                      if (s.isDirectory()) entries.push({ name, path: full, kind: "dir" });
                      else if (s.isFile()) entries.push({ name, path: full, kind: "file" });
                    } catch {
                      // skip — mirrors the sync `catch { continue }`
                    }
                  }),
                );
              });
            } catch (err) {
              if (err instanceof FsDeadlineError) {
                blocked = "timeout";
                entries.length = 0;
              } else {
                throw err;
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof FsDeadlineError) blocked = "timeout";
        else throw err;
      }

      // Entries a restricted caller could never use are hidden, but ancestors
      // of a rule stay so the tree can be walked down to it. Directories only —
      // a FILE under an allowed root is fine, one outside it is noise. Then a
      // stable alphabetical order: `readdir` returns inode order, which the
      // picker rendered as "random" (operator report, 2026-09-30).
      const visible: DirEntry[] =
        blocked !== undefined
          ? []
          : sortDirEntries(
              allowedDirs.length === 0 ? entries : entries.filter((e) => dirNavigable(e.path, allowedDirs)),
            );
      // Both sections in one response so the picker needs one request per
      // folder. A path is listed once — favorites win over recents. Both
      // sections are scoped to the browsed machine on EITHER transport
      // (a remote explore ships that node's rows — see exploreNode).

      const favorites = await favoritePathsFor(user.id);
      const starred = new Set(favorites.map((f) => f.path));
      const recent = (await recentPathsFor(user.id))
        .filter((r) => !starred.has(r.path))
        .slice(0, 3)
        .map(({ path: p, label }) => ({ path: p, label }));
      return { path: resolved, parent, entries: visible, recent, favorites, blocked } as const;
    },
    {
      query: t.Object({
        path: t.Optional(t.String({ description: "Directory to list (defaults to home)" })),
        node: t.Optional(
          t.String({
            description:
              "Node id to browse; omitted or 'local' = the control-plane host. A remote browse relays the node's own refusals: 409 NODE_OUTDATED, NODE_OFFLINE or NODE_UNREACHABLE",
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
      // rule the node routes apply (spec 2026-08-31 §6.2) — absent and
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
      // The node's launch scope answers every question in this response,
      // computed once (the paths filter shares it through the wrapper).
      const dirs = await launchScopeFor(user.id, nodeId);
      const paths = (await recentPathsFor(user.id, nodeId, dirs)).map(({ path, label }) => ({ path, label }));
      // The pre-fill fallback: a fresh instance has no recents at all, so
      // without this the new-subshell form opens on an empty absolute-path
      // box at exactly the moment the user knows least. For an agent node
      // this is what it reported on `ready`; the plane cannot see its disk,
      // and an offline node has no facts, which is why this is nullable.
      // A home BEYOND the node's rules is nullable for the same reason
      // (operator probe, 2026-09-20): the form would seed a directory this
      // caller cannot launch into, re-staging the seed-a-403 trap the whole
      // filter exists to prevent. Managers and unrestricted nodes see `dirs`
      // empty, where `dirAllowed` passes everything. Note the two halves are
      // deliberately DIFFERENT tests: `paths` rides the full `isAllowedRoot`
      // (dirs + FS_ROOT + realpath) because a recent row names a path this
      // picker could be pointed at, while `home` needs only the node's own
      // rules — the launch gate that would refuse it consults nothing else
      // on a node, and FS_ROOT does not reach another machine's disk.
      const rawHome = nodeId === LOCAL_NODE_ID ? homedir() : (getLive(nodeId)?.agent?.homeDir ?? null);
      const home = rawHome !== null && dirAllowed(rawHome, dirs) ? rawHome : null;
      return { paths, home } as const;
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
      const nodeId = body.node?.trim() || LOCAL_NODE_ID;
      const repo = new FavoritesRepository(db);
      if (nodeId !== LOCAL_NODE_ID) {
        // A STAR ON ANOTHER MACHINE names a path on ITS filesystem — the
        // plane must not `resolve`/`expandTilde` it against this host's
        // layout (that would happily "normalize" a path this host cannot
        // see), and `SUBSHELL_FS_ROOT` does not reach there either. What the
        // plane CAN enforce is its own two answers: which nodes this caller
        // may see at all (404, never 403 — the no-oracle rule `/recent` and
        // `/explore` apply), and the node's directory allowlist — which
        // stops the class of star that is dead FOR THIS CALLER by their own
        // node's rules. The read filter in `favoritePathsFor` is stricter by
        // design (it also rides `SUBSHELL_FS_ROOT` and plane-host realpath
        // checks the write gate cannot apply to a path on another machine),
        // so a star can still save 200 and not render under a confinement
        // that was never meant to reach the node's disk.
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
        if (!isAbsolute(path)) {
          throw new FilesError("invalid", "A node path must be absolute", 400);
        }
        const stored = resolve(path); // lexical normalization only — no fs is consulted
        const dirs = await launchScopeFor(user.id, nodeId);
        if (dirs.length > 0 && !dirAllowed(stored, dirs)) {
          throw new FilesError("forbidden", "Path outside this node's allowed directories", 403);
        }
        // Known conservative corner, inherited from the shared list filter:
        // `favoritePathsFor` ALSO answers isAllowedRoot, whose `SUBSHELL_FS_ROOT`
        // and realpath checks are this host's — so under a set FS_ROOT a node
        // star outside that root saves fine here but is filtered from the
        // listing (review Minor, 2026-09-20). The write gate deliberately does
        // not mirror that: FS_ROOT is documented to never confine a node, and
        // refusing the star would make the walk's stance and the star's
        // disagree loudly instead of the list erring closed quietly.
        await repo.setFavorite(user.id, "directory", stored, body.favorite, nodeId);
        return { ok: true } as const;
      }
      const resolved = resolve(expandTilde(path, homedir()));
      // Starring is a path affordance, so `local`'s rules gate it too —
      // otherwise a favorite could be created that the picker then filters
      // straight back out, which reads as the star silently failing.
      const allowedDirs = await launchScopeFor(user.id, LOCAL_NODE_ID);
      if (!(await isAllowedRoot(resolved, allowedDirs))) {
        throw new FilesError("forbidden", "Path outside allowed roots", 403);
      }
      await repo.setFavorite(user.id, "directory", resolved, body.favorite);
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
