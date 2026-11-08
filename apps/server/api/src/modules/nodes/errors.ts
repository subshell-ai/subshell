/**
 * Shared predicates for node-write failures — the DB-shape knowledge that
 * turns an index violation into the right HTTP 409 lives here, not in one
 * route file (enroll and rename both hit `idx_nodes_owner_name`).
 */

/** True when a failed insert/update hit the per-owner unique name index (idx_nodes_owner_name). */
export function isUniqueNameViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed") && msg.includes("nodes");
}

/**
 * The node's share rows are no longer the set the caller read (the whole-set
 * PUT carries the caller's observed row ids into its transaction and refuses
 * when they differ). The rung `manage` made shares multi-writer, so "the
 * authority I was checked against still stands" needs an assertion at commit
 * time, not just at gate time; a revoked manager's in-flight write lands here.
 */
export class NodeSharesConflictError extends Error {
  constructor() {
    super("Node sharing changed; refresh and retry");
    this.name = "NodeSharesConflictError";
  }
}
