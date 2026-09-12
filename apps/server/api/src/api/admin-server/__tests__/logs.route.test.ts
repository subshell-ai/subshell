import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { adminServerRoutes } from "@/api/admin-server/index.js";
import { logsSeams } from "@/api/admin-server/logs.route.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { authedRequest } from "../../__tests__/helpers/auth-tables.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "./fixture.js";

const app = new Elysia().use(errorHandlerPlugin).use(adminServerRoutes);

describe("GET /api/admin/server/logs", () => {
  let fx: AdminServerFixture;
  const realPath = logsSeams.path;
  let dir: string;

  beforeAll(async () => {
    fx = await setupAdminServerFixture("srv-logs");
    dir = mkdtempSync(join(tmpdir(), "subshell-logs-route-"));
    const file = join(dir, "server.log");
    const lines = [0, 1, 2, 3, 4].map((i) =>
      JSON.stringify({
        timestamp: `2026-09-12T10:00:0${i}.000Z`,
        level: i === 3 ? "warn" : "info",
        message: `line-${i}`,
      }),
    );
    // The trailing fragment is the real case: a line severed by the cap.
    writeFileSync(file, `${lines.join("\n")}\n{not json`);
    logsSeams.path = () => file;
  });
  afterAll(async () => {
    logsSeams.path = realPath;
    rmSync(dir, { recursive: true, force: true });
    await fx.cleanup();
  });

  it("returns the file's tail, oldest first, with a raw entry for a non-JSON line", async () => {
    const res = await app.fetch(authedRequest("/api/admin/server/logs?lines=3", fx.adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: { level: string; message: string }[];
      file: string;
      bytes: number;
      capBytes: number;
    };
    expect(body.lines.map((l) => l.message)).toEqual(["line-3", "line-4", "{not json"]);
    expect(body.lines[0]?.level).toBe("warn");
    expect(body.lines[2]?.level).toBe("raw");
    expect(body.capBytes).toBe(204_800);
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.file.endsWith("server.log")).toBe(true);
  });

  it("clamps lines to 1..1000", async () => {
    expect((await app.fetch(authedRequest("/api/admin/server/logs?lines=0", fx.adminCookie))).status).toBe(400);
    expect((await app.fetch(authedRequest("/api/admin/server/logs?lines=5000", fx.adminCookie))).status).toBe(400);
  });

  it("answers empty, not 500, when the file does not exist yet", async () => {
    const present = logsSeams.path;
    logsSeams.path = () => join(dir, "absent.log");
    try {
      const res = await app.fetch(authedRequest("/api/admin/server/logs", fx.adminCookie));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { lines: unknown[]; bytes: number }).lines).toEqual([]);
    } finally {
      logsSeams.path = present;
    }
  });

  it("refuses a non-admin cookie and any bearer key with 403", async () => {
    expect((await app.fetch(authedRequest("/api/admin/server/logs", fx.userCookie))).status).toBe(403);
    expect((await app.fetch(bearerRequest("/api/admin/server/logs", fx.bearer))).status).toBe(403);
  });
});
