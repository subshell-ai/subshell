/**
 * The TanStack Query keys, exported from one home. They are name-only (an
 * instance switch clears the cache in the provider), and a bare string literal
 * at six call sites would turn any rename into silent no-op invalidations —
 * the badge/list would stop refreshing with no type error (review, #11).
 */
export const SUBSHELLS_KEY = ["subshells"] as const;
export const SUMMARY_KEY = ["summary"] as const;
/** The node registry for the launch picker (read-only here — never invalidated). */
export const NODES_KEY = ["nodes"] as const;
/** One subshell's detail row (the pill on the detail screen). */
export const subshellKey = (id: string) => ["subshell", id] as const;
