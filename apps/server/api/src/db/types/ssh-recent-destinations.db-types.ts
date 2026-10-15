/** One owner's most recent successful connection to a canonical destination. */
export interface SshRecentDestinationTable {
  id: string;
  ownerUserId: string;
  destination: string;
  alias: string | null;
  nodeId: string;
  lastConnectAt: string;
}
