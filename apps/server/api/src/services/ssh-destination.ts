/**
 * Spell the canonical destination that keys {@link SshRecentDestinationTable}:
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

/** A preset may reuse alias settings only while they still resolve to its saved destination. */
export function sshExpectedDestinationProblem(snapshot: SshDestinationTriple, expected?: string): string | null {
  if (expected === undefined) return null;
  if (parseSshCanonicalDestination(expected) && sshCanonicalDestination(snapshot) === expected) return null;
  return "This SSH configuration now resolves to a different destination than the preset saved. Edit the preset’s destination to approve the new address.";
}
