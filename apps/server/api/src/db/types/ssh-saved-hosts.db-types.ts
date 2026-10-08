/**
 * One saved or recently-used SSH destination for one owner (spec 2026-10-07
 * §7). Keyed by the RESOLVED canonical destination so an edited alias can
 * never silently re-point a saved row. `saved_at` is what the human gave it;
 * recency is `last_connect_at`, which every launch refreshes whether or not
 * the row was ever saved.
 */
export interface SshSavedHostTable {
  /** Unique row id (uuid) */
  id: string;
  /** Owning user id (FK to users, ON DELETE CASCADE) */
  ownerUserId: string;
  /**
   * The canonical key: `user@host:port` for a resolved snapshot that carries
   * a user, `host:port` (no user prefix) when the snapshot's user is null,
   * the latter meaning the connecting account's own default. The spelling
   * rule is {@link sshCanonicalDestination}; both writers import it; the list reads back
   * the stored strings. It has no other home. Unique per owner
   * (idx_ssh_saved_hosts_owner_destination).
   */
  destination: string;
  /** display-only alias (the config token typed or discovered); never used as a key */
  alias: string | null;
  /** the connecting machine used for the most recent launch to this destination */
  nodeId: string;
  /** ISO 8601 the human saved this destination (null = recency-only row) */
  savedAt: string | null;
  /** ISO 8601 of the most recent launch to this destination */
  lastConnectAt: string;
}

/**
 * Spell the canonical destination that keys {@link SshSavedHostTable}:
 * `host:port`, prefixed with `user@` when the resolved snapshot carries a
 * user. The host is passed through as given - an IPv6 literal arrives
 * already bracketed (`[::1]`) and the port suffix is what disambiguates it.
 */
export function sshCanonicalDestination({
  host,
  port,
  user,
}: {
  host: string;
  port: number;
  user: string | null;
}): string {
  return user === null ? `${host}:${port}` : `${user}@${host}:${port}`;
}
