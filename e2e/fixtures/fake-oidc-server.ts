/**
 * The e2e fake OIDC issuer — a FOURTH process in the stack, on a fixed
 * browser-reachable port (ports.ts's `fakeIdp`), spawned by stack.ts the way
 * it spawns fake-registry.ts and for the same reason: the Playwright runner
 * is Node, so globalSetup cannot host a `Bun.serve` itself.
 *
 * It reuses the request handlers of the in-test fake
 * (`apps/server/api/src/api/__tests__/helpers/fake-oidc.ts`, Task 7): the
 * discovery document, the one-shot code minted by `/authorize` and consumed
 * by `/token`, and the mutable profile answered by `/userinfo`. Both fakes
 * issue NO id_token and carry no verification — the doors seed their rows
 * through the real save path, whose discovery runs against THIS issuer and
 * stores the endpoint triple, so better-auth discovers nothing at runtime and
 * reads the profile from `/userinfo` (the measured genericOAuth path). The
 * Task 7 quirk the caller must know carries over verbatim: **the profile must
 * carry a stable `id`** — with no discovery document, genericOAuth's
 * `accountSubject` is `profile.id`, not the OIDC `sub`, so repeat flows for
 * one person must present one id or they would land as fresh accounts.
 *
 * What the subprocess adds over the in-test helper: a control seam. A
 * Playwright spec cannot reach into a child process's memory to swap the
 * profile, so `PUT /_profile` replaces the `/userinfo` answer (a `null` body
 * makes `/userinfo` answer 500, Task 7's contract) and `GET /_profile` reads
 * it back — and doubles as stack.ts's readiness probe. `/token`'s
 * code→redirect_uri binding stays unverified for the same reason Task 7's
 * left it: this harness exercises OUR policy plumbing, not better-auth's
 * OAuth correctness.
 */

/**
 * The one `Bun` global this file uses, declared rather than typed by a
 * dependency — fake-registry.ts's precedent, same reason: the e2e package is
 * Node-typed for the RUNNER, and this script is run by `bun
 * fake-oidc-server.ts <port>`.
 */
declare const Bun: {
  serve(opts: { hostname: string; port: number; fetch: (req: Request) => Response | Promise<Response> }): {
    hostname: string;
    port: number;
  };
};

const PORT = Number(process.argv[2] ?? "3197");

/** The profile `/userinfo` answers; `null` makes it 500. Swapped by `/_profile`. */
let profile: Record<string, unknown> | null = null;
/** Codes minted by `/authorize`, consumed once by `/token`. */
const pending = new Set<string>();
/** Filled after listen: the discovery document must name the real origin. */
let base = "";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
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
    if (u.pathname === "/_profile") {
      if (req.method === "PUT") {
        profile = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        return Response.json({ ok: true });
      }
      return Response.json({ profile });
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

base = `http://${server.hostname}:${server.port}`;
console.log(`[fake-oidc] listening on ${base}`);
