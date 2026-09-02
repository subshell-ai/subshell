/**
 * Client-side mirrors of the backend's name-length rules, so inputs can
 * refuse an invalid value before the round-trip. Values copied verbatim from
 * the TypeBox schemas (`minLength: 1` + these maxima): sessions and
 * workspaces 120 (`sessions/update-session-name.route.ts`,
 * `workspaces/create-workspace.route.ts`), nodes 64
 * (`nodes/rename-node.route.ts`).
 */

/** Session / workspace display names. */
export const NAME_MAX_DEFAULT = 120;

/** Node display names. */
export const NODE_NAME_MAX = 64;
