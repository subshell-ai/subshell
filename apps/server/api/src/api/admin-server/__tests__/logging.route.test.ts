import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { currentDebugLogging, setDebugLogging } from "@/services/logging-preference.js";
import { serverLogFile } from "@/utils/log-file.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

/** PUT the logging switch with an admin cookie. */
function put(cookie: string, body: unknown): Request {
  return authedRequest("/api/admin/server/logging", cookie, { method: "PUT", body: JSON.stringify(body) });
}

describe("PUT /api/admin/server/logging", () => {
  let fx: AdminServerFixture;
  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-logging");
  });
  afterAll(async () => {
    delete process.env.SUBSHELL_DEBUG_LOGGING;
    // The transport is module state shared with every other suite in this
    // process, so leaving it at `debug` would change what they write.
    await setDebugLogging(false);
    await fx.cleanup();
  });
  afterEach(() => {
    delete process.env.SUBSHELL_DEBUG_LOGGING;
  });

  it("turns debug on and off, live, and persists it; the view reflects it", async () => {
    let res = await app.fetch(put(fx.adminCookie, { debug: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { logging: { debug: boolean; source: string } }).logging).toMatchObject({
      debug: true,
      source: "setting",
    });
    expect(serverLogFile.level).toBe("debug");
    expect(currentDebugLogging()).toEqual({ debug: true, source: "setting" });

    res = await app.fetch(put(fx.adminCookie, { debug: false }));
    expect(res.status).toBe(200);
    expect(serverLogFile.level).toBe("info");

    const events = await new AuditRepository(db).listLatest(10);
    expect(events.filter((e) => e.action === "server.logging.update").length).toBeGreaterThanOrEqual(2);
  });

  it("409 LOGGING_FROM_ENV while the environment forces it", async () => {
    process.env.SUBSHELL_DEBUG_LOGGING = "1";
    const res = await app.fetch(put(fx.adminCookie, { debug: false }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("LOGGING_FROM_ENV");
  });

  it("refuses a non-admin cookie and any bearer key with 403", async () => {
    expect((await app.fetch(put(fx.userCookie, { debug: true }))).status).toBe(403);
    const res = await app.fetch(
      bearerRequest("/api/admin/server/logging", fx.bearer, { method: "PUT", body: JSON.stringify({ debug: true }) }),
    );
    expect(res.status).toBe(403);
  });
});
