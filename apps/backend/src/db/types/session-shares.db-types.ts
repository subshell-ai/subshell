/** A grant's permission level. `view` = read/observe; `edit` = interact + manage (not destroy). */
export type SessionSharePermission = "view" | "edit";

/**
 * Database table schema for one per-session access grant.
 *
 * `granteeUserId` NULL is the "Everyone" grant (applies to every signed-in
 * user); otherwise it names a single user. Uniqueness of the (session,
 * grantee) pair — including a single Everyone row — is enforced by the
 * repository's transactional replace, not a unique index (SQLite treats NULLs
 * as distinct, so an index could not constrain the Everyone row).
 */
export interface SessionShareTable {
  /** Unique id (uuid) */
  id: string;
  /** The session this grant applies to (cascade-deleted with it) */
  sessionId: string;
  /** Grantee user id, or NULL for the "Everyone" (all signed-in) grant */
  granteeUserId: string | null;
  /** Access level conferred by this grant */
  permission: SessionSharePermission;
  /** User id who created the grant (the session owner) */
  createdBy: string;
  /** ISO 8601 timestamp when the grant was created */
  createdAt: string;
}
