/** Origin IDs are broker identities, never a machine label or a credential. */
export interface SshSavedLocationTable {
  id: string;
  ownerUserId: string;
  originKind: "node" | "desktop";
  originId: string;
  alias: string;
  host: string;
  port: number;
  user: string | null;
  path: string;
  createdAt: string;
}
