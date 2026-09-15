import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

/**
 * Every top-level key, asserted WHOLE so a field cannot be added without a
 * decision — the same rule `GET /api/settings/instance` carries, and for the
 * same reason: this payload names filesystem paths and the security posture,
 * so what is in it has to be chosen rather than accumulated.
 */
const VIEW_KEYS = [
  "configEnv",
  "settings",
  "restartRequired",
  "authSecret",
  "paths",
  "service",
  "restart",
  "logging",
  "tmuxPath",
  "mcp",
  "mcpError",
  "platform",
  "generatedAt",
].sort();

describe("GET /api/admin/server", () => {
  let fx: AdminServerFixture;
  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-get");
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it("answers an admin cookie with the whole view and nothing more", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server", fx.adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(VIEW_KEYS);
    const settings = body.settings as Record<string, { saved: string; running: string; source: string }>;
    expect(Object.keys(settings)).toEqual(["SERVER_PORT", "HOST", "APP_BASE_URL", "DATABASE_PATH", "TRUSTED_ORIGINS"]);
    expect(["process env", "config.env", "default"]).toContain(settings.HOST?.source);
    expect(JSON.stringify(body)).not.toContain("BETTER_AUTH_SECRET=");
  });

  // Nested inside `service`, so VIEW_KEYS above is untouched — but it must
  // reach the wire, and as a real tri-state rather than an absent field.
  it("carries the linger fact in the service block", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server", fx.adminCookie));
    // Typed as PRESENT, and the key assertion is what proves the cast: an
    // optional type plus a `?? null` would have let an absent field satisfy
    // the tri-state check, which is the one thing this test exists to catch.
    const body = (await res.json()) as { service: { linger: boolean | null } };
    expect(Object.keys(body.service)).toContain("linger");
    expect([true, false, null]).toContain(body.service.linger);
  });

  it("reports the log file the toggle governs, and its cap", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server", fx.adminCookie));
    const body = (await res.json()) as {
      logging: { debug: boolean; source: string; file: string; capBytes: number };
      paths: { serverLog: string };
    };
    expect(body.logging.capBytes).toBe(204_800);
    expect(body.logging.file).toBe(body.paths.serverLog);
  });

  it("refuses a non-admin cookie and any bearer key with 403, and anonymous with 401", async () => {
    expect((await app.fetch(authedRequest("/api/admin/server", fx.userCookie))).status).toBe(403);
    expect((await app.fetch(bearerRequest("/api/admin/server", fx.bearer))).status).toBe(403);
    expect((await app.fetch(new Request("http://localhost:3080/api/admin/server"))).status).toBe(401);
  });
});
