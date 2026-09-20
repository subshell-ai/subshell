/**
 * The guards that make an UNAUTHENTICATED loopback surface safe to serve.
 *
 * The dashboard has no login by design (it answers the CLI's questions for
 * the same OS user, who can already type every one of them at a shell). What
 * it does NOT get for free is the browser. Three refusals, each closing one
 * hole that an unauthenticated listener on every developer's machine would
 * otherwise open:
 *
 * - **`Host` must name loopback.** DNS rebinding: a hostile domain whose TTL
 *   is set low resolves to 127.0.0.1 in the victim's browser, which then
 *   happily sends `Host: evil.example.com` to THIS server — same-origin by
 *   the browser's own math, no CORS preflight, every mutation readable. The
 *   allowlist is read off the header the request carries, never off the
 *   interface it arrived on, because the interface proves nothing about the
 *   name the browser typed. (The plane's TRUSTED_ORIGINS registry closes the
 *   same hole from the other end; there are no extra names here to trust.)
 * - **`Origin`, when present, must be this same loopback origin.** A
 *   cross-site page CAN open `<img>`/`no-cors` reads against loopback; a
 *   same-origin check on the mutating verbs is what stops any page in the
 *   browser from pressing service stop on a hunch.
 * - **Mutating requests must carry `content-type: application/json`.** A
 *   "simple" cross-origin form POST (url-encoded/text/plain) reaches any
 *   server with no preflight at all — even one with no cookies to steal.
 *   Requiring JSON forces a preflight, and the preflight is what the Origin
 *   rule above can defend.
 *
 * What is deliberately NOT here: tokens, cookies, sessions. For the machine's
 * own user the port is equivalent to the CLI, and the loopback bind plus these
 * checks are what keep it to that user's browser. The accepted gap is a
 * MULTI-USER machine — another local user can reach 127.0.0.1 too, and a
 * no-credential port hands them acts the owner's 0600 config was written to
 * withhold from them (repointing the agent, which discloses the node key, most
 * of all). That is an accepted WIDENING, not parity, and `docs/security.md` §6
 * accounts for it exactly that way, on the product's single-user assumption.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function json(message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Decide one request. Returns a refusal Response, or null when it may proceed.
 * `hostHeader`/`originHeader`/`contentType` are read from the request by the
 * server; they are parameters so the rule is unit-testable without a socket.
 */
export function refuseRequest(input: {
  method: string;
  hostHeader: string | null;
  originHeader: string | null;
  contentType: string | null;
}): Response | null {
  // 1. Host: loopback name, any port (the page may be opened on the port it
  // likes; what must not be possible is a NON-loopback name answering).
  const host = input.hostHeader ?? "";
  const hostName = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  if (!LOOPBACK_HOSTS.has(hostName.toLowerCase())) {
    return json("this node's dashboard answers loopback requests only");
  }

  // 2. Origin: absent (curl, a non-browser client) passes; present must be a
  // loopback origin. `null` origin (sandboxed frames, file://) is refused on
  // mutations below by the content-type rule as well.
  if (input.originHeader !== null && input.originHeader !== "") {
    let originHost = "";
    try {
      originHost = new URL(input.originHeader).hostname.toLowerCase();
    } catch {
      return json("malformed Origin");
    }
    if (!LOOPBACK_HOSTS.has(originHost)) {
      return json("this node's dashboard answers its own origin only");
    }
  }

  // 3. Mutations must be JSON — the preflight forcing the browser to have
  // asked the Origin question above.
  if (input.method !== "GET" && input.method !== "HEAD") {
    if (!(input.contentType ?? "").toLowerCase().startsWith("application/json")) {
      return json("this endpoint expects application/json");
    }
  }
  return null;
}
