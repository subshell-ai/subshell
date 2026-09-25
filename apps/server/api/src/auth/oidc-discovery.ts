/**
 * Discovery resolution and the entry-validation rules for admin-managed
 * OIDC doors (spec 2026-09-24 §3/§5).
 *
 * `resolveEndpoints` runs ONLY on the admin write path and the in-dialog
 * probe; the auth BUILD reads the stored endpoints and never touches the
 * network (that is what makes a rebuild safe while the issuer is briefly
 * dead). The validators are pure and shared with the SPA's preview mirror —
 * `slugifyProviderId` in particular is byte-identical to the web's
 * `previewProviderId`, because the create dialog sends its preview as the id
 * and the stored truth must match what the copy panel showed.
 */

/** The three endpoints genericOAuth needs, in the exact shape the row persists. */
export interface ResolvedEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string | null;
}

/** Discovery refused: the document could not be fetched or lacks an endpoint. */
export class DiscoveryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "DiscoveryError";
  }
}

/**
 * Submitted entry data that cannot be accepted — a bad origin, a bad domain,
 * a slug with no usable characters. Always names the offending entry; the
 * route renders it as a 400. Carries no secret by construction: the inputs
 * it can name (origins, domains, name slugs) are non-secret by rule.
 */
export class EntryInputError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EntryInputError";
  }
}

/**
 * Fetch the issuer's OIDC discovery document.
 *
 * `{issuer}/.well-known/openid-configuration` with trailing slashes trimmed
 * (a pasted `https://idp.example/` must not become `…//​.well-known`), on a
 * 10-second deadline so a dead IdP costs a button press, not a hung request.
 * Exported for the probe route, which needs the RAW document (the soft
 * `grant_types_supported` signal) and not just the endpoint triple.
 */
export async function fetchDiscoveryDocument(issuer: string): Promise<Record<string, unknown>> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new DiscoveryError(`discovery returned ${res.status}`);
    doc = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    throw new DiscoveryError("discovery document could not be fetched");
  }
  if (typeof doc !== "object" || doc === null) throw new DiscoveryError("discovery document was not an object");
  return doc;
}

/** The endpoint triple a discovery document must carry (spec §3: genericOAuth's minimum). */
export function endpointsFromDocument(doc: Record<string, unknown>): ResolvedEndpoints {
  const need = (k: string): string => {
    const v = doc[k];
    if (typeof v !== "string" || v === "") throw new DiscoveryError(`discovery document has no ${k}`);
    return v;
  };
  const ui = doc.userinfo_endpoint;
  return {
    authorizationUrl: need("authorization_endpoint"),
    tokenUrl: need("token_endpoint"),
    userInfoUrl: typeof ui === "string" && ui !== "" ? ui : null,
  };
}

/**
 * Discovery resolution for provider SAVES: fetch the document and return the
 * exact object the row persists. A refusal is a `DiscoveryError` naming the
 * reason; the caller turns it into a 400 `DISCOVERY_FAILED`.
 */
export async function resolveEndpoints(issuer: string): Promise<ResolvedEndpoints> {
  return endpointsFromDocument(await fetchDiscoveryDocument(issuer));
}

/**
 * Bare-origin validation for entry hosts (§5a): http(s) scheme, a host,
 * credentials and wildcards refused — the trusted-origin component rule, and
 * the refusal message names the offending entry. Anything after the
 * authority (path, query, fragment) is DISCARDED rather than refused, so
 * `https://x.example/path` canonicalizes to `https://x.example` (an admin
 * pasting a login-page URL means that host; `URL.origin` is the exact string
 * browsers send and the callback is joined onto it at §5a).
 */
export function normalizeEntryOrigin(raw: string): string {
  const value = raw.trim();
  if (value === "") throw new EntryInputError(`entry origin "${raw}" is empty`);
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url) throw new EntryInputError(`entry origin "${raw}" is not an absolute http(s) URL`);
  const fail = (why: string): never => {
    throw new EntryInputError(`entry origin "${raw}" ${why}`);
  };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`uses scheme "${url.protocol.replace(/:$/, "") || "?"}"; only http and https are allowed`);
  }
  // Wildcards in the AUTHORITY are the better-auth `wildcardMatch` hole —
  // `https://*` would trust every https origin. `*`/`?` after the authority
  // are just characters in a path that `URL.origin` discards anyway.
  if (/[*?]/.test(url.host)) fail("carries a wildcard; an entry origin must name one host");
  if (url.username !== "" || url.password !== "") fail("carries credentials");
  // `URL.origin` is the literal "null" for opaque hosts; an empty host cannot
  // happen once the protocol parsed, but the belt keeps the return honest.
  if (url.host === "" || url.origin === "null") fail("names no host");
  return url.origin;
}

/**
 * Bare-domain entries for `allowed_domains` (§5): lowercase, no `@`, no
 * wildcards, no scheme; deduped, order kept. Returns `[]` for empty input —
 * empty means ANY domain, which the route stores as NULL, never as a column
 * holding the empty string.
 */
export function normalizeDomains(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim().toLowerCase();
    if (entry === "") continue;
    const refuse = (why: string): never => {
      throw new EntryInputError(`allowed domain "${piece.trim()}" ${why}`);
    };
    if (entry.includes("://")) refuse("carries a scheme; a domain is bare");
    if (entry.includes("@")) refuse("carries an address; a domain is bare");
    if (/[*?]/.test(entry)) refuse("carries a wildcard; list exact domains");
    if (/[\s/\\#]/.test(entry)) refuse("is not a bare domain");
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** The reserved id of the credential door — never a choosable slug. */
const RESERVED_PROVIDER_ID = "email";

/**
 * `name` → id slug: lowercase, `[a-z0-9-]`, runs collapsed, trimmed of
 * leading/trailing dashes, ≤ 40 chars. MUST stay byte-identical to the SPA's
 * `previewProviderId` (`apps/server/web/src/types/auth-provider.ts`) — the
 * dialog sends its preview as the create body's `id`, so the registration
 * panel's prediction and the stored truth are the same string.
 *
 * `email` is refused as a user-chosen slug: it is the reserved row's id, and
 * a door whose callback is `/api/auth/callback/email` would collide with the
 * credential door's identity.
 */
export function slugifyProviderId(name: string): string {
  // The leading/trailing-dash trim runs AFTER the 40-char cap. Capping last
  // used to strand a dash at position 40 ("a"*39 + "-b" → "a"*39 + "-"),
  // which the route's strict-id gate then refused — the admin's own
  // legitimate preview quoted back as invalid, making a real provider
  // uncreatable. Trim-after-cap makes the pass idempotent:
  // slugify(slugify(x)) === slugify(x) for every x.
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    throw new EntryInputError(`name "${name}" contains no characters a provider id can be built from`);
  }
  if (slug === RESERVED_PROVIDER_ID) {
    throw new EntryInputError('"email" is the reserved id of the credential door; pick another name');
  }
  return slug;
}
