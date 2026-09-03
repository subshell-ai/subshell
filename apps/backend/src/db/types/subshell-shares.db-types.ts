/** A grant's permission level. `view` = read/observe; `edit` = interact + manage (not destroy). */
export type SubshellSharePermission = "view" | "edit";

/**
 * Database table schema for one per-subshell access grant.
 *
 * `granteeUserId` NULL is the "Everyone" grant (applies to every signed-in
 * user); otherwise it names a single user. Uniqueness of the (subshell,
 * grantee) pair — including a single Everyone row — is enforced by the
 * repository's transactional replace, not a unique index (SQLite treats NULLs
 * as distinct, so an index could not constrain the Everyone row).
 */
export interface SubshellShareTable {
  /** Unique id (uuid) */
  id: string;
  /** The subshell this grant applies to (cascade-deleted with it) */
  subshellId: string;
  /** Grantee user id, or NULL for the "Everyone" (all signed-in) grant */
  granteeUserId: string | null;
  /** Access level conferred by this grant */
  permission: SubshellSharePermission;
  /** User id who created the grant (the subshell owner) */
  createdBy: string;
  /** ISO 8601 timestamp when the grant was created */
  createdAt: string;
}
