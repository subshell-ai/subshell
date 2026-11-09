/**
 * Node access level a share grants (spec §2: any share grants launch; edit
 * adds config). `manage` (spec 2026-11-07) adds the owner-only band — shares,
 * rename, maintenance, the allowlist, key rotation, repointing, stop/uninstall
 * — but never transfer, DELETE or RE-REGISTER. The column has no CHECK: the
 * wire schema and this union are the validation, matching the older two.
 */
export type NodeSharePermission = "view" | "edit" | "manage";

/**
 * Database table schema for per-node access grants — mirror of subshell_shares.
 */
export interface NodeShareTable {
  /** Unique id (uuid) */
  id: string;
  /** Node this grant is on */
  nodeId: string;
  /** Grantee user id; NULL means the "Everyone" grant */
  granteeUserId: string | null;
  /** 'view' | 'edit' | 'manage' */
  permission: NodeSharePermission;
  /** User id who created the grant */
  createdBy: string;
  /** ISO 8601 creation time */
  createdAt: string;
}
