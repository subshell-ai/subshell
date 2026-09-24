import type { Server } from "bun";

/** The handle on a running fake issuer: its URL, a mutable profile, and shutdown. */
export interface FakeIdp {
  /** Origin of this issuer, e.g. `http://127.0.0.1:<port>` — store it as the door's issuer. */
  url: string;
  /** Swap the profile `/userinfo` answers with, between flows (null makes it 500). */
  setProfile(p: Record<string, unknown> | null): void;
  /**
   * Serve one request against the issuer without an HTTP hop. Used to simulate
   * the browser's navigation to `/authorize`: a real `fetch()` would FOLLOW the
   * 302 (a fetch client cannot observe a redirect's Location with
   * `redirect: "manual"` portably), and the point of the hop is the Location.
   */
  handle(req: Request): Promise<Response>;
  /** Stop listening. */
  close(): void;
}

/**
 * An OIDC issuer small enough to hold in your head, big enough to satisfy
 * genericOAuth's code+userinfo path. NO id_token is issued: the door row
 * carries explicit endpoints and a userInfoUrl, so better-auth discovers
 * nothing, verifies no JWT, and reads the profile from `/userinfo` (the
 * measured path through `plugins/generic-oauth`), and nothing needs verifying.
 *
 * Two measured quirks the caller must know:
 *
 * - **The profile must carry a stable `id`.** Without a discovery document,
 *   genericOAuth's `isOidc` stays false and the default `accountSubject` reads
 *   `profile.id` — not the OIDC `sub` claim — so an id-less profile makes
 *   every arrival a fresh account. (`sub` is echoed too, for realism.)
 * - **The code→redirect_uri binding is NOT verified** by this fake: `/token`
 *   answers any one-shot code previously minted by `/authorize` and ignores
 *   which redirect it was minted for. This harness tests OUR policy plumbing;
 *   better-auth's OAuth correctness is theirs.
 */
export async function startFakeIdp(initialProfile: Record<string, unknown>): Promise<FakeIdp> {
  let profile: Record<string, unknown> | null = initialProfile;
  const pending = new Set<string>(); // codes minted by /authorize, consumed by /token
  let base = "";
  const server: Server<undefined> = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
        });
      }
      if (u.pathname === "/authorize") {
        const target = u.searchParams.get("redirect_uri");
        if (!target) return new Response("missing redirect_uri", { status: 400 });
        const code = crypto.randomUUID();
        pending.add(code);
        const redirect = new URL(target);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
        return Response.redirect(redirect.toString(), 302);
      }
      if (u.pathname === "/token") {
        const form = await req.formData().catch(() => null);
        const code = form?.get("code");
        // One-shot: a code the issuer never minted (or already spent) is the
        // INVALID_CODE branch of the callback, not a token.
        if (typeof code !== "string" || !pending.delete(code)) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ access_token: "tok", token_type: "bearer", expires_in: 3600 });
      }
      if (u.pathname === "/userinfo") {
        if (profile === null) return new Response("no profile", { status: 500 });
        return Response.json(profile);
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  return {
    url: base,
    setProfile: (p) => {
      profile = p;
    },
    // `server.fetch` may answer synchronously OR as a promise; awaiting
    // collapses both into the declared Promise<Response>.
    handle: async (req) => await server.fetch(req),
    // bun 1.4.0's serve handle is `stop()`; there is no `close()` (measured).
    close: () => server.stop(),
  };
}
