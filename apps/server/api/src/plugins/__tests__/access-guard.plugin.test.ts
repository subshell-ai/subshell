import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { RequestGuardSpec } from "@internal/pane-runtime";
import { Elysia } from "elysia";
import { type CryptoKey, generateKeyPair, SignJWT } from "jose";
import {
  type AccessGuardDeps,
  accessGuardPlugin,
  activeAccessGuards,
  setAccessGuardDepsForTests,
  setAccessGuards,
  setPluginGuards,
} from "@/plugins/access-guard.plugin.js";

/**
 * The Cloudflare Access front door (spec 2026-09-15 § 6).
 *
 * **This suite drives a REAL listener rather than `app.fetch`**, and that is
 * the point rather than a preference: two of the properties under test — that
 * `onRequest` runs on a WebSocket upgrade, and that a request's peer address
 * can be read at all — are facts about Bun's server, and an in-process
 * dispatch has neither a socket nor a peer.
 *
 * ## The measurement (spec § 10.6), recorded
 *
 * On **Elysia 1.4.29 / Bun 1.4.2**, `onRequest` DOES run for the upgrade
 * request on a `.ws()` route, and a `Response` returned from it prevents the
 * upgrade — the socket's `open` hook never fires and the client sees a
 * failure, not a connection. `"blocks a websocket upgrade"` below is that
 * measurement as a test. Because it holds, `wsPlugin` needed no edit: there is
 * no `requireAccess` called from inside the two upgrade hooks, and if this
 * test ever goes red that fallback is what the guard needs to stay correct.
 *
 * ## Why the guards are registered on `127.0.0.1`
 *
 * `fetch` will not let a caller set `Host`, so the suite makes the Host real
 * instead: `http://127.0.0.1:<port>` and `http://localhost:<port>` reach the
 * SAME listener with two different Host headers, so guarding one of them
 * exercises both the matching and the non-matching path against one server.
 */

const PORT = 31971;
const GUARDED_HOST = "127.0.0.1";
const TEAM_DOMAIN = "subshell-test.cloudflareaccess.com";
const AUD = "aud-for-the-test-application";

const GUARD: RequestGuardSpec = {
  kind: "cloudflare-access",
  hostname: GUARDED_HOST,
  teamDomain: TEAM_DOMAIN,
  aud: AUD,
};

let privateKey: CryptoKey;
let publicKey: CryptoKey;

/** A token the guard should accept, unless an override says otherwise. */
async function mintToken(
  overrides: { issuer?: string; audience?: string; expiresAt?: number; email?: string } = {},
): Promise<string> {
  const jwt = new SignJWT({ email: overrides.email ?? "operator@subshell.local" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? `https://${TEAM_DOMAIN}`)
    .setAudience(overrides.audience ?? AUD)
    .setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600);
  return await jwt.sign(privateKey);
}

/**
 * The JWKS seam, answering with this suite's own public key.
 *
 * `jwks` RETURNS a getKey function — the shape `jose`'s `createRemoteJWKSet`
 * produces — rather than a key. Handing `jwtVerify` a promise instead is a
 * silent failure that reads as "every token is invalid", which is what this
 * shape being explicit prevents.
 */
const testJwks: AccessGuardDeps["jwks"] = () => async () => publicKey;

/** The deps for the ordinary case: the suite's own key pair, the real peer lookup. */
function realPeerDeps(): AccessGuardDeps {
  return {
    jwks: testJwks,
    peerAddress: (request, server) => server?.requestIP?.(request)?.address ?? null,
  };
}

const app = new Elysia()
  .use(accessGuardPlugin)
  .get("/ping", () => ({ ok: true }))
  .ws("/ws-probe", {
    open(ws) {
      ws.send("open");
    },
  });

let server: ReturnType<typeof app.listen>;

/** Connects a WebSocket and reports what happened, without hanging the suite. */
async function probeWebSocket(host: string, headers: Record<string, string> = {}): Promise<"open" | "refused"> {
  return await new Promise((resolve) => {
    // Bun's WebSocket accepts extra request headers, which is how the cookie
    // fallback is exercised — a browser cannot set one on an upgrade, which is
    // exactly why the cookie path exists.
    const ws = new WebSocket(`ws://${host}:${PORT}/ws-probe`, { headers } as unknown as string[]);
    const settle = (result: "open" | "refused") => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(() => settle("refused"), 2000);
    ws.onopen = () => settle("open");
    ws.onerror = () => settle("refused");
    ws.onclose = () => settle("refused");
  });
}

describe("access-guard plugin", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey as CryptoKey;
    publicKey = pair.publicKey as CryptoKey;
    server = app.listen({ port: PORT, hostname: "127.0.0.1" });
    // The listener is bound synchronously by `listen`, but a first request
    // racing the callback has been seen to connect-refuse on CI.
    await Bun.sleep(100);
  });

  afterAll(() => {
    setAccessGuardDepsForTests(null);
    setAccessGuards([]);
    server.stop(true);
  });

  beforeEach(() => {
    setAccessGuardDepsForTests(realPeerDeps());
    setAccessGuards([{ pluginId: "fixture", spec: GUARD }]);
  });

  it("does not touch a hostname no guard names", async () => {
    // Same listener, different Host. Nothing about this request carries an
    // assertion, and it must still be answered — a guard is scoped to one
    // hostname, so loopback-by-another-name, the LAN and every enrolled node
    // stay exactly on the path they had before a publish.
    const res = await fetch(`http://localhost:${PORT}/ping`);
    expect(res.status).toBe(200);
  });

  it("answers normally when no guard is installed at all", async () => {
    setAccessGuards([]);
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`);
    expect(res.status).toBe(200);
  });

  it("admits a matching Host carrying a valid assertion header", async () => {
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": await mintToken() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("admits the CF_Authorization cookie, which is how an upgrade carries one", async () => {
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { cookie: `other=1; CF_Authorization=${await mintToken()}; trailing=2` },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a matching Host with no assertion at all", async () => {
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.message).toContain(GUARDED_HOST);
  });

  it("refuses a token signed by a key the team's JWKS does not carry", async () => {
    // The suite's seam serves one public key, so without this nothing proved
    // the signature is checked at all rather than merely the claims.
    const stranger = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "someone@example.com" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(stranger.privateKey);
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": token },
    });
    expect(res.status).toBe(403);
  });

  it("matches a Host whose case differs", async () => {
    // A hostname is case-insensitive, so `GUARDED.example.com` names the
    // guarded host and must not walk past a guard installed for it.
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { host: `${GUARDED_HOST.toUpperCase()}:${PORT}` },
    });
    expect(res.status).toBe(403);
  });

  it("is not skipped by a PERCENT-ENCODED host", async () => {
    // Measured before the fix: `Host: 127%2E0.0.1` and `%31%32%37.0.0.1` both
    // reached a guarded listener with a 200, because the hand-rolled
    // normalizer never decoded — so neither the map lookup nor the comma
    // refusal fired and the loopback belt was never consulted. Bun itself
    // decodes when it builds `request.url`, so the runtime serving the request
    // and the guard in front of it named different hosts. Any character can be
    // encoded, so this is a family of spellings rather than one.
    for (const host of [`127%2E0.0.1`, `%31%32%37.0.0.1`]) {
      const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, { headers: { host } });
      expect([host, res.status]).toEqual([host, 403]);
    }
  });

  it("is not skipped by a trailing dot on the Host header", async () => {
    // `guarded.example.com.` is the fully-qualified spelling of the same name
    // and resolves identically, so a comparison that only lowercases and
    // strips the port lets a client name a guarded host in a form the guard
    // does not recognize.
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { host: `${GUARDED_HOST}.:${PORT}` },
    });
    expect(res.status).toBe(403);
  });

  it("is not skipped by a second Host header", async () => {
    // Measured on Bun 1.4.2: two Host headers reach the handler joined as
    // `a, b`, which matches no guard. There is no honest reading of two Host
    // headers, so a request naming a guarded host anywhere in that value is
    // refused rather than admitted by the ambiguity.
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { host: `elsewhere.invalid, ${GUARDED_HOST}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an expired assertion", async () => {
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": await mintToken({ expiresAt: Math.floor(Date.now() / 1000) - 120 }) },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an assertion minted for another Access application", async () => {
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": await mintToken({ audience: "some-other-application" }) },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an assertion from another Access team", async () => {
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": await mintToken({ issuer: "https://someone-else.cloudflareaccess.com" }) },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a valid assertion arriving from a peer that is not loopback", async () => {
    // THE BELT. `cloudflared` runs on this host and always connects over
    // loopback, so a guarded hostname reaching the listener from anywhere else
    // is a client that picked the Host header itself — and the token being
    // valid does not make that request one Cloudflare forwarded.
    setAccessGuardDepsForTests({ jwks: testJwks, peerAddress: () => "10.1.2.3" });
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": await mintToken() },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain("local tunnel");
  });

  it("refuses when the peer cannot be determined", async () => {
    // Fails CLOSED. `requestIP` answers null for an in-process dispatch; on a
    // guarded hostname "I cannot tell where this came from" may not admit a
    // request.
    setAccessGuardDepsForTests({ jwks: testJwks, peerAddress: () => null });
    const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
      headers: { "cf-access-jwt-assertion": await mintToken() },
    });
    expect(res.status).toBe(403);
  });

  it("accepts every loopback spelling as the local tunnel", async () => {
    for (const peer of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
      setAccessGuardDepsForTests({ jwks: testJwks, peerAddress: () => peer });
      const res = await fetch(`http://${GUARDED_HOST}:${PORT}/ping`, {
        headers: { "cf-access-jwt-assertion": await mintToken() },
      });
      expect([peer, res.status]).toEqual([peer, 200]);
    }
  });

  it("refuses with no exemption for the anonymous and root paths", async () => {
    // Access covers the WHOLE hostname. `/`, `/install.sh` and the one
    // anonymous read are all inside it, so a 403 here means Access is
    // misconfigured — which the operator has to see rather than route around.
    for (const path of ["/", "/install.sh", "/api/settings/instance", "/ping"]) {
      const res = await fetch(`http://${GUARDED_HOST}:${PORT}${path}`);
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it("swaps the guard set wholesale", () => {
    const second: RequestGuardSpec = { ...GUARD, hostname: "elsewhere.example.com" };
    setAccessGuards([
      { pluginId: "a", spec: GUARD },
      { pluginId: "b", spec: second },
    ]);
    expect(activeAccessGuards().map((g) => g.spec.hostname)).toEqual([GUARDED_HOST, "elsewhere.example.com"]);
    // The publish route's idiom: replace this PLUGIN's guards and leave every
    // other plugin's alone. By hostname it would have missed after a settings
    // change, which is how a guard became unremovable.
    setPluginGuards("a", [{ ...GUARD, aud: "rotated" }]);
    expect(activeAccessGuards().map((g) => g.spec.hostname)).toEqual(["elsewhere.example.com", GUARDED_HOST]);
    expect(activeAccessGuards().find((g) => g.spec.hostname === GUARDED_HOST)?.spec.aud).toBe("rotated");
  });

  it("hands back a copy, so a caller cannot mutate the live set", () => {
    const set = activeAccessGuards();
    set.push({ pluginId: "smuggler", spec: { ...GUARD, hostname: "smuggled.example.com" } });
    expect(activeAccessGuards().map((g) => g.spec.hostname)).toEqual([GUARDED_HOST]);
  });

  it("blocks a websocket upgrade on a guarded hostname (the § 10.6 measurement)", async () => {
    expect(await probeWebSocket(GUARDED_HOST)).toBe("refused");
  });

  it("admits a websocket upgrade carrying the CF_Authorization cookie", async () => {
    expect(await probeWebSocket(GUARDED_HOST, { cookie: `CF_Authorization=${await mintToken()}` })).toBe("open");
  });

  it("leaves a websocket upgrade on an unguarded hostname alone", async () => {
    expect(await probeWebSocket("localhost")).toBe("open");
  });
});
