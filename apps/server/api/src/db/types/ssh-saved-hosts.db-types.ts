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

/** A canonical destination's three facts (the {@link sshCanonicalDestination} shape). */
export interface SshDestinationTriple {
  host: string;
  port: number;
  user: string | null;
}

/**
 * The exact inverse of {@link sshCanonicalDestination}: split the stored
 * `user@host:port` back into its three facts (Task 12: the approval captures
 * the host-key pin by ASKING A for a destination, and the ask takes the
 * triple). Unambiguous because the composer built it: the user is before the
 * first `@`, the port after the LAST `:` - and the host is either a plain
 * name or a bracketed IPv6 literal, so a `:` inside a host never sits after
 * the final one. null for anything the composer would not have written: no
 * port part, a non-numeric or out-of-range port, an empty host or user.
 */
export function parseSshCanonicalDestination(text: string): SshDestinationTriple | null {
  const at = text.indexOf("@");
  const user = at === -1 ? null : text.slice(0, at);
  const rest = at === -1 ? text : text.slice(at + 1);
  const colon = rest.lastIndexOf(":");
  if (colon < 1) return null;
  const host = rest.slice(0, colon);
  const portText = rest.slice(colon + 1);
  if (host === "" || (user !== null && (user === "" || user.includes("@")))) return null;
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65_535) return null;
  return { host, port, user };
}
