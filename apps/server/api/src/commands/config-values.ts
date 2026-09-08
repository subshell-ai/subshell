/**
 * The VALUES `init`/`configure` own: which keys they write, the flag that
 * overrides each one, and what makes a value acceptable.
 *
 * Split from `configure.ts` because it is a separable concern with no IO —
 * pure predicates over strings — and because the flow file had grown past the
 * size the house style asks for (`.claude/rules/code-style.md`). Splitting it
 * also gives these their own test file, which matters more than the line count:
 * every rule here is the difference between an instance a browser can sign in
 * to and a 403 "Invalid origin", and several of them are non-obvious enough to
 * be worth pinning directly rather than through the command that calls them.
 */

/** The four keys `configure` always writes from its answers. */
export const OWNED_KEYS = ["SERVER_PORT", "HOST", "APP_BASE_URL", "DATABASE_PATH"] as const;

/**
 * Keys `configure` owns but writes CONDITIONALLY: an empty answer REMOVES the
 * line rather than writing an empty one.
 *
 * `TRUSTED_ORIGINS` is the only one, and the asymmetry is the point. The other
 * four have a built-in default worth writing down; this one's built-in default
 * is a non-empty list (`constants.ts` — the dev Vite origins), so writing
 * `TRUSTED_ORIGINS=` would be a SETDEFAULT-visible empty value that beats
 * `.env` in the ladder and silently strips those origins from a developer's
 * own machine. Absent means "whatever the built-in says"; present means "this
 * list".
 *
 * One accepted consequence: a HAND-WRITTEN `TRUSTED_ORIGINS=` in config.env is
 * turned into "key absent" by the next `configure` run, so the built-in dev
 * origins apply again. That loses a deliberate "trust nothing extra" —
 * knowingly, because the two states are indistinguishable to every consumer
 * except the precedence ladder, where an empty value beats `.env` and silently
 * strips those origins on a developer's own machine. That footgun is what this
 * key exists to avoid writing; preserving someone else's copy of it would
 * reintroduce the thing being avoided. Set the env var if you truly need it.
 */
export const OPTIONAL_KEYS = ["TRUSTED_ORIGINS"] as const;

/** Any key the init/configure flow resolves an answer for. */
export type ConfigKey = (typeof OWNED_KEYS)[number] | (typeof OPTIONAL_KEYS)[number];

/**
 * The flag that overrides each key. Only used to make a refusal actionable —
 * a message that names the stored value's home should also name the way past
 * it — but it lives here, beside the keys, so a renamed flag cannot leave the
 * message pointing at one that no longer exists. `cli.ts` owns the parsing;
 * this is the same set of strings, asserted equal by its own test.
 */
export const FLAG_FOR_KEY: Record<ConfigKey, string> = {
  SERVER_PORT: "--port",
  HOST: "--host",
  APP_BASE_URL: "--base-url",
  DATABASE_PATH: "--db-path",
  TRUSTED_ORIGINS: "--trusted-origins",
};

/** True for a URL string that parses and speaks http(s). */
function isHttpUrl(value: string): boolean {
  try {
    const proto = new URL(value).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/**
 * The port a browser would actually dial for this base URL — explicit, else
 * the scheme's default. Null when it does not parse.
 *
 * The scheme default is what keeps a PROXIED deployment from being called a
 * mismatch: `https://subshell.example` in front of a server listening on 3080
 * is the normal production shape, and the browser dials 443. Only a base URL
 * naming a CONCRETE non-default port that disagrees with the bind port is
 * evidence of a stale answer.
 */
export function baseUrlPort(value: string): number | null {
  try {
    const url = new URL(value);
    if (url.port !== "") return Number.parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Loopback test on a parsed URL's host — mirrors the frontend's
 * `add-node-dialog` helper (enroll-time loopback trap, spec 2026-08-31):
 * localhost, any 127.x, and the bracketed/bare IPv6 spellings.
 */
export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host.startsWith("127.") || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Is this string usable as a trusted origin? Checked by COMPONENT, not by
 * `url.origin === value`.
 *
 * The equality test was the obvious thing and it was wrong in a way that only
 * shows up as a refusal message about paths: measured on bun 1.4.0, it rejects
 * `http://box.local:3080/` (an address bar's trailing slash),
 * `http://Box.Local:3080` (hosts are case-insensitive, and DNS agrees),
 * `http://[0:0:0:0:0:0:0:1]:3080` (the expanded IPv6 form) and
 * `https://box.local:443` (natural to write for a proxied deployment) — all
 * four of which a URL canonicalizes to exactly the origin a browser would send.
 * So the components decide acceptance and {@link normalizeTrustedOrigins}
 * stores `url.origin`, which makes the stored string literally what
 * better-auth and the CORS plugin compare against.
 *
 * What stays refused is anything carrying information an origin cannot: a
 * path, a query, a fragment — and CREDENTIALS, which are the one thing
 * deliberately not canonicalized away. `URL.origin` drops them silently, so
 * storing it for `http://u:p@box.local:3080` would discard a secret the
 * operator typed without ever saying so.
 *
 * `pathname` alone is not enough for the query and fragment cases: measured,
 * `http://x:3080?q=1` and `http://x:3080#h` both leave `pathname === "/"`.
 */
function isHttpOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname === "") return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return true;
}

/** True when a URL string carries a userinfo component (`user:pass@host`). */
function hasCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

/**
 * The canonical origin for one validated entry — what a browser would put in
 * an `Origin` header. Falls back to the input if it somehow does not parse,
 * which {@link isHttpOrigin} has already ruled out.
 */
function canonicalOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/**
 * Will this entry, AS STORED, match the `Origin` a browser sends?
 * A one-sentence reason when it will not, else null.
 *
 * A different question from {@link validateValue}'s, and deliberately
 * stricter. `configure` is lenient and CANONICALIZES on write, so it accepts
 * `http://Box.Local:3080` and stores `http://box.local:3080`. But a value that
 * arrived by hand-edit or through the env layer never passed through the
 * validator and is used verbatim — and both consumers compare against the
 * serialized origin. So the runtime question is "is this already canonical",
 * which is what `subshell-server status` reports.
 *
 * They share {@link isHttpOrigin} and {@link canonicalOrigin} rather than
 * sharing one predicate, because a diagnostic that disagreed with the
 * validator in either direction would make the tool look broken rather than
 * the config.
 *
 * Reasons say what a BROWSER will do, not what a rule says, because the person
 * reading this is looking at a 403 and needs the mechanism.
 *
 * Wildcards are the deliberate silence: better-auth honours
 * `https://*.example.com` through its own `wildcardMatch` branch, so reporting
 * one would be a lint against a supported feature — and unsilenceable, since
 * the operator meant it. (`configure` still refuses to WRITE one; see
 * {@link validateTrustedOrigins}.)
 */
export function originProblem(entry: string): string | null {
  let url: URL | null = null;
  try {
    url = new URL(entry);
  } catch {
    url = null;
  }
  // A query or fragment is diagnosed BEFORE the wildcard silence, because `?`
  // is both the wildcard character and the query delimiter — checked in the
  // other order, a hand-edited `…?q=1` got no diagnostic at all, though
  // better-auth reads it as a pattern that matches nothing.
  if (url !== null && (url.search !== "" || url.hash !== "")) {
    const part = url.search !== "" ? "query" : "fragment";
    return `'${entry}' carries a ${part}, and an Origin header never does — it will not match`;
  }
  if (/[*?]/.test(entry)) return null;
  if (!isHttpOrigin(entry)) {
    // `://` is the discriminator for "has a scheme", NOT whether `new URL`
    // threw: `new URL("box.local:3080")` parses happily with protocol
    // `box.local:`, so keying off the throw made the commonest mistake report
    // itself as using "the 'box.local:' scheme". A scheme in an origin is
    // always followed by `://`.
    //
    // These two conditions are also SEPARATE, which they were not: OR-ing them
    // sent every parse failure into the no-scheme branch, so
    // `http://box.local:99999` was reported as "has no http(s) scheme" —
    // wrong advice on the one surface whose whole job is to be actionable.
    //
    // No scheme. The suggestion is SELF-CHECKED rather than assumed: prepending
    // http:// is the fix for a bare `host:port`, but for something that only
    // looks scheme-less it produces garbage — `http://mailto:a@b.c` parses with
    // `mailto` as a USERNAME and host `b.c`. So it is offered only when the
    // result is a credential-free origin.
    if (!entry.includes("://")) {
      const candidate = `http://${entry}`;
      // Suggested in CANONICAL form, so a mixed-case bare host gets the
      // spelling a browser would actually send rather than an echo of the typo.
      const usable = isHttpOrigin(candidate) && !hasCredentials(candidate);
      return (
        `'${entry}' has no http(s) scheme, so a browser's Origin header can never equal it` +
        (usable ? ` — browsers send e.g. "${canonicalOrigin(candidate)}"` : "")
      );
    }
    // A WRONG scheme is a different mistake, and it needs a different
    // sentence: prepending http:// to the raw entry produced advice reading
    // `browsers send e.g. "http://ftp://box.local:3080"`, which is nonsense in
    // the one place whose whole job is to be actionable. The suggestion is
    // rebuilt from the authority instead, and omitted when there is none to
    // rebuild from (`mailto:a@b.c` parses but has no host).
    // Has a scheme, but the parser could not make a URL of it — an
    // out-of-range port, a malformed host, no authority at all.
    if (url === null) {
      return `'${entry}' could not be parsed as a URL — check the host and the port`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      const usable = url.host === "" ? "" : ` — browsers send e.g. "http://${url.host}"`;
      return `'${entry}' uses the '${url.protocol}' scheme, and a browser's Origin is only ever http(s)${usable}`;
    }
    // Query and fragment are handled above, so a survivor here is a path.
    return `'${entry}' carries a path, and an Origin header never does — it will not match`;
  }
  const canonical = canonicalOrigin(entry);
  if (canonical !== entry) {
    return `'${entry}' is not the form a browser sends: it sends '${canonical}', which will not match this entry`;
  }
  return null;
}

/**
 * Is `APP_BASE_URL` usable? A one-sentence reason when it is not, else null.
 *
 * The stronger of the two diagnostics. `localOriginsFor` swallows a parse
 * failure on purpose ("a malformed APP_BASE_URL is not worth a boot failure
 * over"), so an unusable value silently removes the instance's OWN origin from
 * the allowlist — and the same value is better-auth's baseURL and the passkey
 * rpID. Nothing at boot says a word about it.
 */
export function baseUrlProblem(value: string): string | null {
  if (isHttpUrl(value)) return null;
  return (
    `'${value}' is not a full http(s) URL, so this instance's own origin is missing from the ` +
    'allowlist — sign-in from the address you browse will fail with 403 "Invalid origin"'
  );
}

/**
 * Validate the `TRUSTED_ORIGINS` list. Empty is acceptable (it means "no
 * extras"); otherwise EVERY comma-separated entry must be an origin, because
 * one unusable entry is exactly the case where the user believes an address is
 * allowed and it is not. The message names the offending entry — a refusal
 * that only says "the list is wrong" leaves them to bisect it by hand.
 */
function validateTrustedOrigins(value: string): string | null {
  if (value.trim() === "") return null;
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") {
      return `invalid trusted origins '${value}': it has an empty entry (a stray or trailing comma)`;
    }
    // Refused BEFORE the origin check, because `URL.origin` round-trips a
    // wildcard happily — `new URL("https://*")` parses with host `*` — so
    // nothing downstream would catch it.
    //
    // This is a security boundary, not a formatting rule. better-auth's
    // `matchesOriginPattern` branches on the PATTERN: anything containing `*`
    // or `?` goes to `wildcardMatch` instead of the exact
    // `pattern === getOrigin(url)` comparison, so (measured, better-auth
    // 1.7.1) `TRUSTED_ORIGINS=https://*` trusts EVERY https origin —
    // dissolving the static allowlist that docs/security.md §8 describes as
    // what closes the DNS-rebinding hole. `@elysiajs/cors` would still reject
    // it, but CORS is a browser courtesy rather than a server-side gate: a
    // non-browser client sends whatever Origin it likes and better-auth's
    // check is the only thing in the way.
    //
    // An operator who genuinely wants a pattern can still set the env var or
    // hand-edit config.env; refusing here keeps the documented property true
    // of every value these two NEW surfaces — a CLI flag and a desktop text
    // field — can write.
    if (/[*?]/.test(entry)) {
      return (
        `invalid trusted origin '${entry}': wildcards are not accepted — this list must name each ` +
        "address exactly, because a pattern would let an origin nobody enumerated sign in"
      );
    }
    // Before the origin check, so the message is about the credentials rather
    // than about a shape that would otherwise look acceptable.
    if (hasCredentials(entry)) {
      return (
        `invalid trusted origin '${entry}': it carries a username or password, and an origin cannot — ` +
        "drop the credentials rather than having them silently discarded"
      );
    }
    if (!isHttpOrigin(entry)) {
      return (
        `invalid trusted origin '${entry}': expected a bare http(s) origin with no path ` +
        "(e.g. http://box.local:3080), comma-separated for several"
      );
    }
  }
  return null;
}

/**
 * Validate one resolved value for its key; null = acceptable, a string is the
 * stderr line. Every message names the offending value, because these are read
 * by someone who typed it — or, since defaults follow the file, by someone who
 * did not and needs to know which value is meant.
 */
export function validateValue(key: ConfigKey, value: string): string | null {
  if (/[\r\n]/.test(value)) {
    return `invalid ${key}: the value must be a single line (it would corrupt config.env)`;
  }
  switch (key) {
    case "SERVER_PORT": {
      if (!/^\d+$/.test(value)) return `invalid port '${value}': expected an integer 1-65535`;
      const n = Number.parseInt(value, 10);
      if (n < 1 || n > 65535) return `invalid port '${value}': expected an integer 1-65535`;
      // The CANONICAL spelling, not merely a parseable one — a writer must not
      // be looser than the consumer it writes for. `constants.ts` reads the
      // port through env-var's `asPortNumber()`, which refuses "080" outright
      // ("should be a valid integer", measured on env-var 7.5.0), so accepting
      // it here wrote an UNBOOTABLE config.env: every subcommand imports
      // `constants.ts`, so the throw takes down the server, `status`, AND the
      // `configure` run that would repair the value — an instance with no CLI
      // route back. `status` already applies exactly this rule when deciding
      // `portValid`; this is the writer agreeing with both of its readers.
      if (String(n) !== value) {
        return `invalid port '${value}': write it as '${n}' — a leading zero is refused when the server boots`;
      }
      return null;
    }
    case "HOST":
      return value.trim() === ""
        ? "invalid host: must not be empty (127.0.0.1 or 0.0.0.0 are the usual answers)"
        : null;
    case "APP_BASE_URL":
      return isHttpUrl(value)
        ? null
        : `invalid base-url '${value}': expected a full http(s) URL (e.g. http://localhost:3080)`;
    case "DATABASE_PATH":
      return value.trim() === "" ? "invalid database path: must not be empty" : null;
    case "TRUSTED_ORIGINS":
      return validateTrustedOrigins(value);
  }
}

/**
 * Canonicalize a validated origin list: entries trimmed, each serialized
 * through `URL.origin`, comma-joined, no spaces.
 *
 * Storing the canonical form is the other half of {@link isHttpOrigin}'s
 * component check. Both consumers compare against the origin a browser sends —
 * better-auth by equality, the CORS plugin by a map hit — so accepting a
 * spelling without canonicalizing it would write a value neither of them
 * matches, i.e. a config that 403s while the command reported success.
 */
export function normalizeTrustedOrigins(value: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(canonicalOrigin)
    .join(",");
}
