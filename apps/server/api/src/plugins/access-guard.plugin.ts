import { BackendErrorCodes } from "@internal/backend-errors";
import type { RequestGuardSpec } from "@internal/pane-runtime";
import { Elysia } from "elysia";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { IS_TEST } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";

/**
 * The Cloudflare Access front door (spec 2026-09-15 § 6).
 *
 * A `network` plugin that publishes this server on the open internet hands the
 * host a {@link RequestGuardSpec}: "traffic arriving for THIS hostname must
 * carry a valid identity assertion from THIS Access team". The plugin supplies
 * the configuration and this module owns the check, because deciding whether a
 * request reaches the server at all belongs in one audited place mounted ahead
 * of everything — not in code a third party shipped.
 *
 * ## Keyed on `Host`, never on a header-presence rule
 *
 * The obvious implementation — "if `CF-Ray` is present, require an assertion"
 * — is trivially evaded: a client on the LAN simply omits `CF-Ray` and the
 * rule skips itself. A client cannot make a Host rule skip without changing
 * Host, and a request carrying `Host: <tunnel hostname>` with NO assertion is
 * refused wherever it came from. Cloudflare's edge only forwards Hosts inside
 * the zone, so a visitor cannot pick a different Host to evade it either.
 *
 * **Belt:** a matching Host arriving from a peer that is not loopback is
 * refused regardless, because `cloudflared` runs on this host and always
 * connects to the listener from 127.0.0.1. An unknown peer is refused too —
 * see {@link AccessGuardDeps.peerAddress}.
 *
 * ## No exemptions
 *
 * A refusal is a `403` on EVERY path, `/`, `/install.sh` and
 * `/api/settings/instance` included. Access covers the whole hostname, so a
 * 403 here means Access is misconfigured — something the operator has to see
 * rather than something to route around. A hostname no active guard names is
 * not touched at all, which is what keeps loopback, the LAN and every enrolled
 * node on exactly the path they had before a publish.
 *
 * ## The verified identity is NOT a session
 *
 * A passing assertion proves Cloudflare authenticated somebody; it says
 * nothing about who they are HERE. The `email` claim is stashed for audit
 * metadata ({@link accessIdentityFor}) and nothing else: Subshell's own
 * session cookie or bearer key is still required behind this, by every route
 * that required one before. Treating the assertion as a login would let
 * anyone in the Access team act as any Subshell user.
 *
 * ## Measured, not assumed (spec § 10.6)
 *
 * Elysia 1.4.29 on Bun 1.4.2 DOES run `onRequest` for the WebSocket upgrade
 * request on `/ws` and `/ws/node`, and a `Response` returned from it prevents
 * the upgrade (the socket's `open` hook never fires). So this plugin alone
 * covers the WS paths and neither upgrade hook needed an edit. The proof is
 * `__tests__/access-guard.plugin.test.ts`, which drives a real listener rather
 * than `app.fetch`.
 */

/** What a passing assertion told us about the caller. Audit metadata only. */
export interface AccessIdentity {
  /** The `email` claim, when the token carried one. */
  email?: string;
  /** The guard that admitted the request, for the audit line's sake. */
  hostname: string;
}

/**
 * Keyed on the `Request` object rather than stashed on the Elysia context: the
 * context an `onRequest` hook mutates is not the one a route handler reads
 * (measured on the WS path, where the context is rebuilt for the socket), and
 * a `WeakMap` cannot leak — the entry dies with the request.
 */
const identities = new WeakMap<Request, AccessIdentity>();

/**
 * The identity a passing Access assertion carried, for an audit row.
 *
 * Absent means no guard matched this request, which is the ordinary case on
 * loopback and the LAN. **Never a permission check**: nothing may read this to
 * decide access — the route's own gate does that.
 */
export function accessIdentityFor(request: Request): AccessIdentity | undefined {
  return identities.get(request);
}

/** Anything that can report the peer address of a request. Bun's `Server` is one. */
export interface PeerLookup {
  requestIP?: (request: Request) => { address: string } | null;
}

/** The two things this guard reaches outside itself, so a test can supply both. */
export interface AccessGuardDeps {
  /**
   * The JWKS for one Access team, memoised by the caller.
   *
   * Production is `jose`'s {@link createRemoteJWKSet} over
   * `https://<teamDomain>/cdn-cgi/access/certs`, which caches the key set and
   * rate-limits its own refetches — so this is built once per team domain and
   * reused, never per request.
   */
  jwks: (teamDomain: string) => JWTVerifyGetKey;
  /**
   * The peer address of a request, or null when the adapter cannot say.
   *
   * Production reads `server.requestIP(request)`, which answers on both the
   * plain HTTP path and the WebSocket upgrade (measured). It returns null for
   * an in-process `app.fetch`, which is why null is REFUSED rather than
   * allowed: an unverifiable peer on a guarded hostname is exactly the case
   * the belt exists for, and a real listener never produces one.
   */
  peerAddress: (request: Request, server: PeerLookup | null) => string | null;
}

/** One JWKS per Access team domain, for the life of the deps. */
let jwksCache = new Map<string, JWTVerifyGetKey>();

const defaultDeps: AccessGuardDeps = {
  jwks: (teamDomain) => {
    const existing = jwksCache.get(teamDomain);
    if (existing) return existing;
    const set = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
    return set;
  },
  peerAddress: (request, server) => server?.requestIP?.(request)?.address ?? null,
};

let depsOverride: AccessGuardDeps | undefined;

/**
 * Test seam: supply the JWKS and the peer lookup, so a suite can mint its own
 * tokens against a local key pair and drive the belt without a second machine.
 *
 * Refuses outside the suite, the `setTmuxInstallDepsForTests` pattern and for
 * a sharper reason here: a production import able to swap the JWKS would be
 * able to swap the front door's notion of who signed an assertion.
 * @internal
 */
export function setAccessGuardDepsForTests(deps: AccessGuardDeps | null): void {
  if (!IS_TEST) throw new Error("setAccessGuardDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
  // A swapped JWKS source must not be answered out of the previous one's memo.
  jwksCache = new Map();
}

/** The guard set, plus the lookup built from it. Replaced wholesale, never mutated. */
interface ActiveGuards {
  /** As {@link setAccessGuards} was given them, for {@link activeAccessGuards}. */
  specs: readonly OwnedGuard[];
  /** Normalised hostname → spec, the per-request lookup. */
  byHost: ReadonlyMap<string, RequestGuardSpec>;
}

/**
 * One guard, tagged with the plugin the HOST resolved it from.
 *
 * The tag is not part of {@link RequestGuardSpec} and must not become one: a
 * field a plugin filled in would be a field one plugin could use to claim
 * another's guard. This is the host's own bookkeeping, attached where the host
 * already knows the answer.
 */
export interface OwnedGuard {
  /** The plugin whose `requestGuard` produced this. */
  pluginId: string;
  /** What that plugin declared. */
  spec: RequestGuardSpec;
}

let active: ActiveGuards = { specs: [], byHost: new Map() };

/**
 * Replaces the ACTIVE guard set.
 *
 * Wholesale, never incremental: publish and unpublish both compute the set
 * they want and hand it over, so there is no window in which half of one
 * plugin's guard is installed. A hostname appearing twice keeps the LAST
 * entry, which is what makes "filter this hostname out, then append" the
 * idiomatic re-publish.
 *
 * Arming a guard is what makes a tunnel safe, so a caller arms BEFORE the
 * tunnel exists and disarms AFTER it is gone (spec § 5.3).
 */
export function setAccessGuards(guards: OwnedGuard[]): void {
  const byHost = new Map<string, RequestGuardSpec>();
  for (const { spec } of guards) byHost.set(normalizeHost(spec.hostname), spec);
  active = { specs: [...guards], byHost };
}

/** The guard set currently applied, in the order it was installed. */
export function activeAccessGuards(): OwnedGuard[] {
  return [...active.specs];
}

/**
 * Replaces the guards owned by ONE plugin, leaving every other plugin's alone.
 *
 * Ownership is the HOST's record — the plugin id it looked the plugin up by —
 * and never anything the plugin supplied. That is what makes removal work at
 * all: identifying a guard by recomputing it and comparing values meant a
 * settings change while published left the installed guard unremovable, since
 * the plugin now describes a different hostname or audience than the one
 * standing. It also keeps the property the value-identity approach was
 * protecting: a plugin still cannot name another plugin's guard, because it
 * never names an owner.
 * @param pluginId - whose guards these are
 * @param specs - the guards that plugin declares now; empty removes its own
 */
export function setPluginGuards(pluginId: string, specs: RequestGuardSpec[]): void {
  setAccessGuards([
    ...activeAccessGuards().filter((owned) => owned.pluginId !== pluginId),
    ...specs.map((spec) => ({ pluginId, spec })),
  ]);
}

/**
 * A `Host` header reduced to what a guard's `hostname` is compared against.
 *
 * Every step here closes a way of naming the SAME host that a plain
 * lowercase-and-strip-the-port comparison would miss, and a miss means the
 * guard skips itself on a hostname it was installed for. Measured against a
 * Bun 1.4.2 listener:
 *
 * | sent | `headers.get("host")` | without this |
 * |---|---|---|
 * | `Host: guarded.example.com.` | `guarded.example.com.` | missed |
 * | `Host: a` and `Host: b` | `a, b` | missed |
 *
 * - **A duplicate Host header** is joined by the Headers API into `a, b`, which
 *   matches nothing. There is no honest reading of two Host headers, so the
 *   first is taken and compared: a request that names a guarded host at all is
 *   a request that guard must see. (A request naming it SECOND is still
 *   caught, because the whole value matches no guard and the caller then
 *   refuses anything containing a guarded name — see {@link hostMatches}.)
 * - **A trailing dot** is the fully-qualified spelling of the same name and
 *   resolves identically, so `example.com.` and `example.com` are one host.
 * - An IPv6 literal keeps its brackets, the only form a Host header may carry
 *   one in.
 */
function normalizeHost(value: string): string {
  // The first of several, not the joined string: see the docstring.
  const first = value.split(",")[0] ?? "";
  const host = first.trim().toLowerCase();
  const bare = host.startsWith("[")
    ? (() => {
        const end = host.indexOf("]");
        return end === -1 ? host : host.slice(0, end + 1);
      })()
    : (() => {
        const colon = host.indexOf(":");
        return colon === -1 ? host : host.slice(0, colon);
      })();
  // The root label. `example.com.` and `example.com` name the same host.
  return bare.endsWith(".") ? bare.replace(/\.+$/, "") : bare;
}

/**
 * Whether this request names a guarded hostname, by any spelling it could use.
 *
 * Normally the normalized Host IS the answer. The extra pass exists for the
 * duplicate-header case: `Host: unguarded` plus `Host: guarded` arrives as one
 * joined value whose FIRST element is innocent, and a request that names a
 * guarded host anywhere in its Host header is one the guard must not skip.
 * Refusing an ambiguous request costs nothing — there is no legitimate reason
 * to send two Host headers.
 */
function hostMatches(raw: string, hostname: string): boolean {
  if (normalizeHost(raw) === hostname) return true;
  return raw.includes(",") && raw.split(",").some((part) => normalizeHost(part) === hostname);
}

/**
 * Whether an address is this machine talking to itself.
 *
 * The whole 127/8 block, not just 127.0.0.1, and both IPv6 spellings — plus
 * the `::ffff:` mapped form Bun reports on a dual-stack listener. Anything
 * else, including a LAN address of this very host, is not loopback: the point
 * is that `cloudflared` connects over the loopback interface.
 */
function isLoopbackAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * The assertion cookie, for the one case that cannot send a header.
 *
 * A browser opening a WebSocket cannot set `Cf-Access-Jwt-Assertion` — the
 * WebSocket API takes no headers — so Cloudflare's own `CF_Authorization`
 * cookie is what carries the identity there. Read with the same first-match
 * rule the session-cookie helper uses.
 */
function cookieAssertion(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("CF_Authorization=")) {
      const value = trimmed.slice("CF_Authorization=".length);
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/** The refusal body, identical in shape to every other API error. */
function refusal(message: string): Response {
  return new Response(
    JSON.stringify(
      apiErrorBody({
        code: BackendErrorCodes.ACCESS_DENIED,
        message,
      }),
    ),
    { status: 403, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

/**
 * The guard itself: the refusal for this request, or undefined to let it
 * through.
 *
 * Every early return is "no guard names this hostname", which is the common
 * case and costs one map lookup. Everything after the match is the guarded
 * path, where a failure is a refusal rather than a fallthrough.
 */
async function guardRequest(request: Request, server: PeerLookup | null): Promise<Response | undefined> {
  const guards = active;
  if (guards.byHost.size === 0) return undefined;
  // `request.headers.get("host")` rather than the URL's host: Bun reconstructs
  // the URL from the Host header anyway, and reading the header is what this
  // rule is actually about.
  const host = request.headers.get("host");
  if (host === null) return undefined;
  const spec =
    guards.byHost.get(normalizeHost(host)) ??
    // The duplicate-header case: a joined `unguarded, guarded` has an innocent
    // first element, and a request naming a guarded host ANYWHERE in its Host
    // header is one this guard must not skip.
    [...guards.byHost.values()].find((candidate) => hostMatches(host, normalizeHost(candidate.hostname)));
  if (spec === undefined) {
    // A Host carrying a comma or interior whitespace is the `Headers.get` join
    // of duplicate headers, which no legitimate client sends. Falling through
    // to "no guard names this" makes ambiguity the way past a guard, so while
    // ANY guard is installed such a request is refused on its own terms —
    // closing the class rather than the instance above.
    if (/[,\s]/.test(host.trim())) {
      return refusal("This request carried more than one Host header, which this server does not accept.");
    }
    return undefined;
  }

  const deps = depsOverride ?? defaultDeps;

  // THE BELT, before the token is even read. `cloudflared` connects to this
  // listener over loopback, so a guarded hostname arriving from anywhere else
  // is a client that chose the Host header itself. A null peer is refused for
  // the same reason: on a guarded hostname, "I cannot tell where this came
  // from" is not an answer that may admit a request.
  const peer = deps.peerAddress(request, server);
  if (peer === null || !isLoopbackAddress(peer)) {
    return refusal(
      `${spec.hostname} is published through Cloudflare Access, so requests for it are accepted only from the local tunnel.`,
    );
  }

  const token = request.headers.get("cf-access-jwt-assertion") ?? cookieAssertion(request.headers.get("cookie") ?? "");
  if (!token) {
    return refusal(
      `${spec.hostname} is published through Cloudflare Access, and this request carried no Access assertion. If you reached this page without signing in to Access, the Access application for this hostname is misconfigured.`,
    );
  }

  try {
    const { payload } = await jwtVerify(token, deps.jwks(spec.teamDomain), {
      issuer: `https://${spec.teamDomain}`,
      audience: spec.aud,
      // Measured: `createRemoteJWKSet` already refuses a symmetric or `none`
      // `alg` before it produces a key, so algorithm confusion is closed
      // without this. Pinned anyway, because that refusal lives in a
      // dependency and this makes it a property of our own code — the kind of
      // guarantee that should not quietly change under a version bump.
      algorithms: ["RS256"],
      // A little slack between Cloudflare's edge and this host's clock. An
      // assertion minted a second ago must not be refused because the two
      // machines disagree about what "now" is, and thirty seconds is far
      // shorter than any Access session.
      clockTolerance: 30,
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    // Audit metadata only — never a credential. See the module docstring.
    identities.set(request, { hostname: spec.hostname, ...(email ? { email } : {}) });
    return undefined;
  } catch (err) {
    // The reason is the operator's to act on (an expired token, the wrong
    // `aud`, a team domain that does not match), so it is named rather than
    // flattened into "forbidden" — and it says nothing a caller did not
    // already send.
    const reason = err instanceof Error ? err.message : String(err);
    return refusal(`The Cloudflare Access assertion for ${spec.hostname} was not accepted: ${reason}`);
  }
}

/**
 * Mounted in `server.ts` immediately after `errorHandlerPlugin` and BEFORE
 * everything else — cors, the rate limiter, `/install.sh`, auth, the static
 * SPA and the WebSocket routes — so a guarded hostname is checked before any
 * of them has a chance to answer.
 *
 * `.as("global")` because the hook has to apply to every route in the app,
 * not only to routes this plugin declares (it declares none).
 */
export const accessGuardPlugin = new Elysia({ name: "access-guard" })
  .onRequest(async ({ request, server }) => await guardRequest(request, (server as PeerLookup | null) ?? null))
  .as("global");
