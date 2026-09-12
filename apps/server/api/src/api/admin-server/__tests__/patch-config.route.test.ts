import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

/** PATCH the config with an admin cookie and a JSON body. */
function patch(cookie: string, body: unknown): Request {
  return authedRequest("/api/admin/server/config", cookie, { method: "PATCH", body: JSON.stringify(body) });
}

describe("PATCH /api/admin/server/config", () => {
  let fx: AdminServerFixture;
  let dir: string;
  const previousDir = process.env.SUBSHELL_SERVER_CONFIG_DIR;

  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-patch");
    dir = mkdtempSync(join(tmpdir(), "subshell-patch-"));
    writeFileSync(join(dir, "config.env"), "BETTER_AUTH_SECRET=s3cret\nSERVER_PORT=3080\nHOST=0.0.0.0\n");
    process.env.SUBSHELL_SERVER_CONFIG_DIR = dir;
  });
  afterAll(async () => {
    if (previousDir === undefined) delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
    else process.env.SUBSHELL_SERVER_CONFIG_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
    await fx.cleanup();
  });

  it("writes the file exactly as the CLI would, answers the view plus warnings, and audits the change without the secret", async () => {
    const res = await app.fetch(patch(fx.adminCookie, { port: 3090, trustedOrigins: ["http://10.0.0.5:3090"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { SERVER_PORT: { saved: string } };
      warnings: string[];
      restartRequired: boolean;
    };
    expect(body.settings.SERVER_PORT.saved).toBe("3090");
    expect(body.restartRequired).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
    const text = readFileSync(join(dir, "config.env"), "utf8");
    // Every key this tool does not own is carried forward verbatim — above all
    // the once-generated auth secret.
    expect(text).toContain("BETTER_AUTH_SECRET=s3cret");
    expect(text).toContain("SERVER_PORT=3090");
    expect(text).toContain("TRUSTED_ORIGINS=http://10.0.0.5:3090");
    const events = await new AuditRepository(db).listLatest(5);
    const ev = events.find((e) => e.action === "server.config.update");
    expect(ev).toBeDefined();
    expect(ev?.metadataJson ?? "").not.toContain("s3cret");
    expect(ev?.metadataJson ?? "").toContain("SERVER_PORT");
  });

  it("400 CONFIG_INVALID names the field and the CLI's reason, writing nothing", async () => {
    const before = readFileSync(join(dir, "config.env"), "utf8");
    const res = await app.fetch(patch(fx.adminCookie, { baseUrl: "ftp://nope" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("CONFIG_INVALID");
    expect(body.message).toContain("APP_BASE_URL");
    expect(readFileSync(join(dir, "config.env"), "utf8")).toBe(before);
  });

  it("409 CONFIG_KEY_FROM_ENV when the key is set in the process environment", async () => {
    const before = readFileSync(join(dir, "config.env"), "utf8");
    const prev = process.env.HOST;
    process.env.HOST = "127.0.0.1";
    try {
      const res = await app.fetch(patch(fx.adminCookie, { host: "0.0.0.0" }));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("CONFIG_KEY_FROM_ENV");
      expect(body.message).toContain("HOST");
      expect(readFileSync(join(dir, "config.env"), "utf8")).toBe(before);
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });

  /**
   * The systemd shape: `EnvironmentFile=` puts the file's own value in the
   * environment before the process starts. That is not an override — systemd
   * re-reads the file on the next start — so the write must go through.
   */
  it("allows a key the environment holds because config.env is what fed it", async () => {
    const prev = process.env.HOST;
    process.env.HOST = "0.0.0.0"; // exactly what the fixture's config.env says
    try {
      const res = await app.fetch(patch(fx.adminCookie, { host: "0.0.0.0" }));
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });

  /**
   * A read failure is the FILE's problem, not any submitted value's, so it
   * must not come back as CONFIG_INVALID, which the form renders against the
   * field it names. It is a 400 rather than a 500 because the error handler
   * replaces a 500's message with "An internal server error occurred." — and
   * the message is the only actionable part of this refusal.
   */
  it("refuses without naming a field when config.env exists but cannot be read", async () => {
    const broken = mkdtempSync(join(tmpdir(), "subshell-patch-unreadable-"));
    mkdirSync(join(broken, "config.env")); // a directory where the file should be
    process.env.SUBSHELL_SERVER_CONFIG_DIR = broken;
    try {
      const res = await app.fetch(patch(fx.adminCookie, { port: 3090 }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("BAD_REQUEST");
      expect(body.message).toContain("config.env");
    } finally {
      process.env.SUBSHELL_SERVER_CONFIG_DIR = dir;
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("400 on an empty body", async () => {
    expect((await app.fetch(patch(fx.adminCookie, {}))).status).toBe(400);
  });

  it("refuses a non-admin cookie and any bearer key with 403", async () => {
    expect((await app.fetch(patch(fx.userCookie, { port: 3090 }))).status).toBe(403);
    const res = await app.fetch(
      bearerRequest("/api/admin/server/config", fx.bearer, { method: "PATCH", body: JSON.stringify({ port: 3090 }) }),
    );
    expect(res.status).toBe(403);
  });
});
