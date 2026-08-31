/** Node access level a share grants (spec §2: any share grants launch; edit adds config). */
export type NodeSharePermission = "view" | "edit";

/**
 * Database table schema for per-node access grants — mirror of session_shares.
 */
export interface NodeShareTable {
  /** Unique id (uuid) */
  id: string;
  /** Node this grant is on */
  nodeId: string;
  /** Grantee user id; NULL means the "Everyone" grant */
  granteeUserId: string | null;
  /** 'view' | 'edit' */
  permission: NodeSharePermission;
  /** User id who created the grant */
  createdBy: string;
  /** ISO 8601 creation time */
  createdAt: string;
}
