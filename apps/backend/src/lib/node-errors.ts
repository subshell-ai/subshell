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
