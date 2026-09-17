import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { cors } from "@elysiajs/cors";
import { betterAuth } from "better-auth";
import { Elysia } from "elysia";
import { authDatabase } from "@/auth/database.js";
import { AUTH_OPTIONS } from "@/auth.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { corsOriginAllowed } from "@/server.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { setupAuthTables } from "./helpers/auth-tables.js";

/**
 * The property the whole change exists for: an Origin the registry learned
 * a moment ago is accepted by better-auth and echoed by CORS with NO restart,
 * and forgetting it makes the same request 403 again. Driven through the
 * shipped `AUTH_OPTIONS` (so the function-form `trustedOrigins` under test is
 * the real wiring) and the exact `cors({ origin })` predicate `createApp()`
 * mounts.
 *
 * Two measurements about better-auth 1.7.1 shape the mount:
 *
 * - The origin check runs only when the request carries a cookie
 *   (`origin-check.mjs`: `useCookies = headers.has("cookie")`), so the probe
 *   cookie is load-bearing — a cookieless request passes whatever the
 *   allowlist says.
 * - The check SKIPS BY DEFAULT when `NODE_ENV === "test"`
 *   (`create-context.mjs`: `skipOriginCheck = disableOriginCheck !== undefined
 *   ? disableOriginCheck : isTest()`, and `bun test` always sets NODE_ENV=test;
 *   measured — a foreign origin reached "User not found" 401 rather than 403).
 *   So this file mounts a same-options instance with `disableOriginCheck:
 *   false` — the PRODUCTION posture, which is the one this feature changes —
 *   rather than the in-process `getAuth()` singleton, which is born with the
 *   check off. The instance differs in that one flag and nothing else: same
 *   `AUTH_OPTIONS`, same database handle.
 */
const auth = betterAuth({
  ...AUTH_OPTIONS,
  database: authDatabase(),
  advanced: { ...AUTH_OPTIONS.advanced, disableOriginCheck: false },
});
const app = new Elysia()
  .use(errorHandlerPlugin)
  .use(cors({ origin: corsOriginAllowed }))
  .all("/api/auth/*", ({ request }) => auth.handler(request));

const LEARNED = "http://100.117.173.95:3080";
const PLUGIN = "live-origins-test";

function signInFrom(origin: string): Request {
  return new Request("http://localhost:3080/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: "probe=1" },
    body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.invalid`, password: "x" }),
  });
}

describe("a learned origin is trusted live", () => {
  beforeAll(async () => {
    await setupAuthTables();
  });
  afterEach(() => originRegistry().clearPlugin(PLUGIN));
  afterAll(() => originRegistry().clearPlugin(PLUGIN));

  it("ships trustedOrigins as a function, not a captured array", () => {
    // The frozen array was the bug this feature removes: an array is read
    // once at better-auth init and can never learn another origin. The
    // function is re-invoked per request (`base.mjs` getTrustedOrigins and
    // the origin middleware inside validateOrigin) and once at init with no
    // request — hence the optional parameter.
    expect(typeof AUTH_OPTIONS.trustedOrigins).toBe("function");
  });

  it("is 403 before the registry knows it, then not 403 the moment it does, then 403 again once cleared", async () => {
    const before = await app.fetch(signInFrom(LEARNED));
    expect(before.status).toBe(403);
    expect(before.headers.get("access-control-allow-origin")).toBeNull();

    originRegistry().setPluginOrigins(PLUGIN, [LEARNED]);
    const during = await app.fetch(signInFrom(LEARNED));
    expect(during.status).not.toBe(403);
    // Bogus credentials: better-auth's own refusal, reachable only once the
    // origin check has let the request through.
    expect([400, 401]).toContain(during.status);
    expect(during.headers.get("access-control-allow-origin")).toBe(LEARNED);

    originRegistry().clearPlugin(PLUGIN);
    const after = await app.fetch(signInFrom(LEARNED));
    expect(after.status).toBe(403);
  });
});
