/**
 * Whether a promote press MOVES the base URL off another network's address.
 *
 * Every network card carries the same "Set as this server's base URL"
 * checkbox, and `APP_BASE_URL` is ONE value — so publishing with it checked
 * on a second plugin silently re-points the server again, moving the passkey
 * rpID a second time with nothing on screen saying a previous network owned
 * the answer. The checkbox's own copy states that cost generically; a press
 * that actually MOVES an established network address deserves the specific.
 *
 * Two returns of `null` are as load-bearing as the `BaseUrlMove`:
 *
 * - **Same origin** — promoting to what is already the base URL changes
 *   nothing, and asking about a no-op teaches people to dismiss dialogs.
 * - **Loopback origin** — the base URL defaults to `http://localhost:…`, and
 *   moving from it to a network address IS the documented purpose of the
 *   checkbox. Confirming the ordinary path would fire on every first
 *   promote, which is ceremony, not information.
 */
export interface BaseUrlMove {
  /** The host (with port) currently written into APP_BASE_URL */
  fromHost: string;
  /** The host (with port) this press would replace it with */
  toHost: string;
}

/**
 * Decide whether promoting `target` moves a non-loopback `current` base URL.
 *
 * Unparseable inputs answer `null`: a value the card cannot read is not
 * evidence of a move, and the publish must not be gated on a guess.
 */
export function baseUrlMove(current: string | undefined, target: string | undefined): BaseUrlMove | null {
  if (!current || !target) return null;
  let from: URL;
  let to: URL;
  try {
    from = new URL(current);
    to = new URL(target);
  } catch {
    return null;
  }
  if (from.origin === to.origin) return null;
  if (isLoopback(from.hostname)) return null;
  return { fromHost: from.host, toHost: to.host };
}

/** The spellings a browser treats as this machine. */
function isLoopback(hostname: string): boolean {
  // WHATWG `URL.hostname` keeps the brackets on IPv6 ("[::1]"), unlike every
  // other host form — strip them rather than carrying a bracketed case that
  // would silently miss the plain one if any caller ever hands a bare host.
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}
