import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { FavoritesRepository } from "@/db/repositories/favorites.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { RecentPathsRepository } from "@/db/repositories/recent-paths.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { loadNodeAccess } from "@/lib/node-access.js";
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
 * Filesystem exploration for the folder picker (new session form).
 *
 * **This is an authenticated-browser folder picker, not a sandbox.** It
 * browses the host filesystem by design — that is the entire point of the
 * feature — so the real security boundary is the session-user's filesystem
 * permissions: anything the backend's OS user can read is browsable. What
 * this route does control:
 *
 * - **Browser-only**: machine credentials (session keys, system keys) get
 *   403. A running harness holding its own bearer token must not be able to
 *   enumerate the operator's disk; only a signed-in human in the browser
 *   uses the picker (verified: the MCP server never calls this route).
 * - **Optional confinement**: `SUBSHELL_FS_ROOT`, when set, restricts browsing
 *   to that directory tree (paths outside it get 403). When unset — the
 *   default — there is no path confinement. There is no secret allowlist.
 * - One level per request, dotfiles hidden, absolute paths only.
 * - `PATCH /favorite` stars/unstars a path (the picker's Favorites section —
 *   the successor to the removed bookmarks feature); `/explore` ships both
 *   sections so the panel needs one request per folder.
 */
export const filesRoutes = new Elysia({ prefix: "/api/files" })
  .use(authGuard)
  .get(
    "/explore",
    async ({ query, user, actor }) => {
      // Cookie-only by design — see the route docstring. Machine credentials
      // (bearer session keys / system keys) are rejected outright: filesystem
      // browsing is a human-in-the-browser affordance, not a harness API.
      if (actor !== "cookie") {
        throw new FilesError("forbidden", "Folder browsing is restricted to browser sessions", 403);
      }

      const raw = query.path?.trim() || homedir();
      const path = expandTilde(raw, homedir());

      if (!isAllowedRoot(path)) {
        throw new FilesError("forbidden", "Path outside allowed roots", 403);
      }

      let resolved: string;
      try {
        resolved = resolve(path);
        if (!isAllowedRoot(resolved)) {
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

      const parent = resolved === "/" ? null : join(resolved, "..");
      // Both sections in one response so the picker needs one request per
      // folder. A path is listed once — favorites win over recents.
      // The recents section stays LOCAL-scoped on purpose: this picker walks
      // the control-plane filesystem, so a remote node's paths here would be
      // dead clicks. Per-node recents live on /recent?node=<id> instead.
      const favorites = await favoritePaths(user.id);
      const starred = new Set(favorites.map((f) => f.path));
      const recent = (await recentPaths(user.id))
        .filter((r) => !starred.has(r.path))
        .slice(0, 3)
        .map(({ path: p, label }) => ({ path: p, label }));
      return { path: resolved, parent, entries, recent, favorites } as const;
    },
    {
      query: t.Object({
        path: t.Optional(t.String({ description: "Directory to list (defaults to home)" })),
      }),
      response: ExploreResponseSchema,
      detail: {
        operationId: "exploreFiles",
        tags: ["files"],
        description: "Lists a directory (folder picker; browser sessions only)",
      },
    },
  )
  .get(
    "/recent",
    async ({ user, actor, query }) => {
      // Browser-only, like /explore: this pre-fills the new-session form —
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
      if (!isAllowedRoot(resolved)) {
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
function confinementRoot(): string | null {
  const root = process.env.SUBSHELL_FS_ROOT?.trim();
  if (!root) return null;
  const resolved = resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
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
function isAllowedRoot(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const root = confinementRoot();
  if (!root) return true; // no SUBSHELL_FS_ROOT → host FS is browsable by design
  const resolved = resolve(path);
  if (resolved !== root && !resolved.startsWith(root + sep)) return false;
  try {
    const real = realpathSync(resolved);
    return real === root || real.startsWith(root + sep);
  } catch {
    try {
      lstatSync(resolved); // a present-but-unresolvable path (broken symlink)
      return false; // cannot prove where it leads → refuse
    } catch {
      return true; // nothing exists at this path → nothing to leak, 404 next
    }
  }
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
  return all.filter((r) => isAllowedRoot(r.path));
}

/**
 * Starred directories, confinement-filtered the same way — a favorite saved
 * before `SUBSHELL_FS_ROOT` was set must not leak out of the root either.
 */
async function favoritePaths(userId: string) {
  const repo = new FavoritesRepository(db);
  const all = await repo.listByUser(userId, "directory");
  return all.filter((f) => isAllowedRoot(f.ref)).map(({ ref, label }) => ({ path: ref, label }));
}
