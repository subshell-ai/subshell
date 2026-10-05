/**
 * Database table schema for per-pane SSH grants (SSH-SUPPORT.md §2,
 * "Ownership and explicit grants"). A grant permits ONE pane to read/use ONE
 * connection REVISION; it is not a configuration right, and it is not inherited
 * by child or restarted panes.
 *
 * The binding tuple is (connection, pane, CURRENT api key): restart rotates the
 * pane's key, so restart invalidates the grant BY DESIGN - the uniqueness rule
 * is on the ACTIVE state only (`revoked_at IS NULL`), which is what lets a
 * revoked row stay in the table as history while exactly one live row can exist
 * per tuple (migration 0047's partial unique index).
 */
export interface SshGrantTable {
  /** Unique grant id (uuid) */
  id: string;
  /** The connection granted */
  connectionId: string;
  /**
   * The connection revision pinned. A later revision does not satisfy this
   * grant (edit invalidates); a retained run's grant row keeps pointing at
   * the revision it authorized, which is what makes history honest.
   */
  connectionRevision: number;
  /**
   * The pane granted (subshell id). Rows CASCADE with the subshell: a deleted
   * pane takes its grant rows - active and revoked history alike - with it.
   * This is why `ssh_runs.api_key_id` is the durable "who authorized this"
   * fact and grant IDs are not guaranteed to resolve forever (migration 0047).
   */
  subshellId: string;
  /**
   * The granted pane's CURRENT issued api-key identity (better-auth apikey id,
   * the same value `subshells.api_key_id` carries). A token rotation that
   * changes the pane's key makes the old credential fail the grant's
   * identity-equality check - the "no legacy permission fallback" rule, made
   * enforceable per row.
   */
  apiKeyId: string;
  /** The human who granted it (cookie actor; no machine credential can write grants) */
  grantedByUserId: string;
  /** ISO 8601 grant timestamp (DB default) */
  grantedAt: string;
  /** ISO 8601 revocation stamp; NULL = ACTIVE. Revocation prevents new dispatch and fences queued input at the node (generation). */
  revokedAt: string | null;
}

/** Insert shape: DB default fills `grantedAt`; `revokedAt` starts null (active). */
export type NewSshGrant = Omit<SshGrantTable, "grantedAt"> & { grantedAt?: string };

/** Update shape: revocation is the ONLY legal update; the binding tuple is fixed at issue. */
export type SshGrantUpdate = Partial<Pick<SshGrantTable, "revokedAt">>;
