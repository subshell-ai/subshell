/**
 * Query keys shared by hooks and components.
 *
 * `["subshells"]` was spelled by hand in three query definitions and six
 * invalidate/loop sites, so a rename could only ever be found by reading
 * every file. Keys live here; the READ definitions live in the hooks that
 * own them (e.g. `useSubshellsList` in `hooks/use-subshells.ts`), mirroring
 * how `use-presets`/`use-workspaces` keep their own keys next to their
 * query. Prefix keys (a detail query is `[...PREFIX, id]`) double as
 * invalidation prefixes — `invalidateQueries` matches on array prefix.
 */

/** The current user's identity (`getSessionUser` via better-auth); read via `useCurrentUser`. */
export const CURRENT_USER_QUERY_KEY = ["current-user"] as const;

/** The caller's subshell list (`GET /api/subshells`); read via `useSubshellsList`. */
export const SUBSHELLS_QUERY_KEY = ["subshells"] as const;

/** Prefix of one subshell's detail query: `[...SUBSHELL_QUERY_KEY, id]`. */
export const SUBSHELL_QUERY_KEY = ["subshell"] as const;

/** Prefix of a subshell's pane-log tail: `[...SUBSHELL_LOG_QUERY_KEY, id]`. */
export const SUBSHELL_LOG_QUERY_KEY = ["subshell-log"] as const;

/** Prefix of a subshell's sharing grants: `[...SUBSHELL_SHARES_QUERY_KEY, id]`. */
export const SUBSHELL_SHARES_QUERY_KEY = ["subshell-shares"] as const;

/** Prefix of one workspace's detail query: `[...WORKSPACE_QUERY_KEY, id]`. */
export const WORKSPACE_QUERY_KEY = ["workspace"] as const;

/**
 * Prefix of "which workspaces hold this subshell" (`GET /api/workspaces?subshellId=`):
 * `[...SUBSHELL_WORKSPACES_QUERY_KEY, subshellId]`; read via `useSubshellWorkspaces`.
 * Unlike the list query, this one INCLUDES drafts (spec 2026-09-14 §2).
 */
export const SUBSHELL_WORKSPACES_QUERY_KEY = ["subshell-workspaces"] as const;

/** The caller's node list (`GET /api/nodes`); read via `useNodes`. */
export const NODES_QUERY_KEY = ["nodes"] as const;

/** Prefix of one node's detail query: `[...NODE_QUERY_KEY, id]`. */
export const NODE_QUERY_KEY = ["node"] as const;

/** Prefix of a node's sharing grants: `[...NODE_SHARES_QUERY_KEY, id]`. */
export const NODE_SHARES_QUERY_KEY = ["node-shares"] as const;

/** How this server is deployed (`GET /api/admin/server`); read via `useServerDeployment`. */
export const SERVER_DEPLOYMENT_QUERY_KEY = ["server-deployment"] as const;

/** Prefix of the server-log tail: `[...SERVER_LOGS_QUERY_KEY, lines]`. */
export const SERVER_LOGS_QUERY_KEY = ["server-logs"] as const;
