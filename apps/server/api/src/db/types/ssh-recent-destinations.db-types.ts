/** One owner's most recent successful connection to a canonical destination. */
export interface SshRecentDestinationTable {
  /** Row id (uuid) */
  id: string;
  /** Owning user; the ledger is never read across owners */
  ownerUserId: string;
  /** Canonical `host:port` / `user@host:port`; with the owner, the upsert key */
  destination: string;
  /** Display label from the resolved snapshot; a bare-host relaunch keeps it standing */
  alias: string | null;
  /** Node of the MOST RECENT successful launch — the row follows it */
  nodeId: string;
  /** ISO 8601 of that launch; drives the newest-first list and the cap */
  lastConnectAt: string;
}
