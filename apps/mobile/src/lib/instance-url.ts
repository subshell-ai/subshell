/**
 * Instance origin handling. The user types a mote instance, so input arrives in
 * many shapes — `mote.example`, `:3080` suffixes, loopback, NetBird 100.x
 * addresses, trailing slashes — and every later stage (cookie name, WS URL)
 * branches on the scheme, so normalisation happens once, here.
 */

/** A rejected instance address, carrying copy the connect screen can show as-is. */
export class InvalidInstanceUrl extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInstanceUrl";
  }
}

/**
 * True for hosts that are realistically plain-HTTP: loopback, RFC1918, the
 * NetBird/Tailscale CGNAT range, `.local`/`.lan`/single labels, and any bare IP.
 * Used only to choose a scheme when the user typed none — an explicit
 * `http://` is always honoured.
 * @param hostname - Lowercased host part of the URL, without port
 */
export function looksPrivate(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan")) return true;
  if (host === "::1" || host.startsWith("::ffff:127.")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // single label / mDNS-ish
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  // 172.16.0.0/12 and the 100.64.0.0/10 CGNAT range Tailscale/NetBird hand out.
  const m = /^172\.(\d+)\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // 100.64.0.0/10 ONLY — the second octet is 64–127, not the whole /8. Matching
  // all of 100.x would default a PUBLIC 100.24.x.x (AWS) to http and ship the
  // session token in cleartext (regression, review #15).
  const cg = /^100\.(\d+)\./.exec(host);
  if (cg && Number(cg[1]) >= 64 && Number(cg[1]) <= 127) return true;
  // Everything else — including a bare public IPv4 — defaults to https. Getting
  // this backwards sends a session token in cleartext over the open internet;
  // guessing https wrong only costs the user typing an explicit `http://`.
  return false;
}

/**
 * Normalises typed input into a base URL with no trailing slash.
 * Adds a scheme when missing (https, or http for private hosts), keeps an
 * explicit port and any path prefix, and rejects anything that cannot carry a
 * session cookie safely.
 * @param input - What the user typed
 * @returns An absolute base URL, e.g. `https://mote.example` or `http://100.71.37.94:3080`
 * @throws InvalidInstanceUrl with display-ready copy
 */
export function normalizeInstanceOrigin(input: string): string {
  const raw = input.trim();
  if (!raw) throw new InvalidInstanceUrl("Enter the address of your mote instance.");

  // A scheme-less host is parsed under http purely to extract the hostname,
  // which parses identically either way; the real scheme is chosen from it.
  const schemeless = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(schemeless ? `http://${raw}` : raw);
  } catch {
    throw new InvalidInstanceUrl(`"${raw}" is not a web address.`);
  }

  const protocol = schemeless ? (looksPrivate(url.hostname) ? "http:" : "https:") : url.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new InvalidInstanceUrl("Only http and https addresses are supported.");
  }
  if (url.username || url.password) {
    throw new InvalidInstanceUrl("Remove the username and password from the address.");
  }
  if (!url.hostname) throw new InvalidInstanceUrl("That address has no hostname.");

  const path = url.pathname.replace(/\/+$/, "");
  return `${protocol}//${url.host}${path}`;
}

/**
 * The WebSocket origin matching an https/http base — the terminal attaches at
 * `/ws`. Never hardcode `wss://`: plain-HTTP LAN instances are a supported
 * deployment, and guessing wrong produces a socket that silently never opens.
 * @param baseUrl - Output of {@link normalizeInstanceOrigin}
 */
export function wsOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const path = url.pathname.replace(/\/+$/, "");
  return `${scheme}//${url.host}${path}`;
}
