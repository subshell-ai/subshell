/**
 * Query keys shared by hooks and components.
 *
 * `["sessions"]` was spelled by hand in three query definitions and six
 * invalidate/loop sites, so a rename could only ever be found by reading
 * every file. Keys live here; the READ definitions live in the hooks that
 * own them (e.g. `useSessionsList` in `hooks/use-sessions.ts`), mirroring
 * how `use-profiles`/`use-workspaces` keep their own keys next to their
 * query. Prefix keys (a detail query is `[...PREFIX, id]`) double as
 * invalidation prefixes — `invalidateQueries` matches on array prefix.
 */

/** The caller's session list (`GET /api/sessions`); read via `useSessionsList`. */
export const SESSIONS_QUERY_KEY = ["sessions"] as const;

/** Prefix of one session's detail query: `[...SESSION_QUERY_KEY, id]`. */
export const SESSION_QUERY_KEY = ["session"] as const;

/** Prefix of a session's pane-log tail: `[...SESSION_LOG_QUERY_KEY, id]`. */
export const SESSION_LOG_QUERY_KEY = ["session-log"] as const;

/** Prefix of a session's sharing grants: `[...SESSION_SHARES_QUERY_KEY, id]`. */
export const SESSION_SHARES_QUERY_KEY = ["session-shares"] as const;

/** Prefix of one workspace's detail query: `[...WORKSPACE_QUERY_KEY, id]`. */
export const WORKSPACE_QUERY_KEY = ["workspace"] as const;
