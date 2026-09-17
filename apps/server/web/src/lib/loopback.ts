/**
 * True when a URL points at the machine reading it.
 *
 * Two surfaces turn on this and they fail the same way: the Add-node dialog
 * bakes a base URL into an install command a REMOTE machine runs (spec
 * 2026-08-31 enroll-time loopback trap), and the mobile-install dialog offers
 * a phone an address to open. In both, a loopback answer is one the far end
 * dutifully dials on ITSELF.
 *
 * Checked on the URL's HOST, never on the string: `http://127.0.0.1.example.com`
 * is somebody else's domain, and a prefix match on the whole URL would hand it
 * a pass. An unparseable URL is not loopback — this runs in render and must
 * not throw, and the caller's other warnings still apply to it.
 *
 * Deliberately out of scope: a host that is not an address at all, such as the
 * `*` of a wildcard origin. Every sanctioned writer of `TRUSTED_ORIGINS`
 * refuses wildcards (`.claude/rules/security-context.md`), so one can only
 * arrive by hand-editing config.env — and answering "is this loopback" about
 * it is meaningless either way. A caller that must not render nonsense filters
 * on its own terms.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    // WHATWG `URL.hostname` keeps brackets on IPv6 literals (`http://[::1]`
    // -> "[::1]"; the unbracketed form is an invalid URL), so only the
    // bracketed spelling can match. A single trailing dot is the DNS root and
    // survives the parser verbatim, so `http://localhost.` resolves exactly
    // where `http://localhost` does and has to be stripped before comparing.
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return (
      host === "localhost" ||
      // The whole 127/8 block, not just 127.0.0.1: a server bound anywhere in
      // it is reachable from this machine and from nowhere else. Matched as a
      // dotted quad rather than a `"127."` prefix, which also swallows
      // `127.0.0.1.example.com` — somebody else's domain, and one a browser
      // will happily resolve off-box. The parser has already canonicalized
      // every shorthand spelling (`http://127.1` and `http://2130706433` both
      // come back as `127.0.0.1`), so the quad is the only form left to match.
      /^127(\.\d{1,3}){3}$/.test(host) ||
      host === "[::1]" ||
      // IPv4-mapped IPv6, which the parser rewrites into hex before anything
      // here sees it: `[::ffff:127.0.0.1]` arrives as `[::ffff:7f00:1]`. Same
      // machine, and it would otherwise read as a routable address.
      /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
    );
  } catch {
    return false;
  }
}
