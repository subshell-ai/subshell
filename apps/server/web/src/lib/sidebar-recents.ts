/**
 * How many entries each "recent" sub-list shows. (Spec 2026-09-03
 * sidebar-quickadd §3: 3 was too few to spot a session among; the nav scrolls,
 * so 8 costs nothing structurally.) The Workspaces rail section slices to this
 * when no search is written; the subshell rail's recents render FULL entities
 * (status dot, menu, drag), so the old projection helpers that once lived here
 * have no job left.
 */
export const RECENT_LIMIT = 8;
