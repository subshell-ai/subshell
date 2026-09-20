/**
 * The query keys for the node reads every node-admin surface shares.
 *
 * They live HERE because the hooks that write-through and invalidate them
 * moved with the cards. The control-plane SPA keeps its own `lib/query-keys.ts`
 * for everything else and imports these two from this package — one spelling
 * per key, or a mutation in one surface would miss the cache in the other.
 */

/** Key of the visible-node list (`GET /api/nodes`). */
export const NODES_QUERY_KEY = ["nodes"] as const;

/** Key of one node's detail view, spread with the id (`GET /api/nodes/:id`). */
export const NODE_QUERY_KEY = ["node"] as const;
