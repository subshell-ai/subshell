import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { settingsRoutes } from "@/api/settings.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * GET/PATCH /api/settings are admin-COOKIE routes.
 *
 * The regression these pin: authGuard maps a session token's `user` to its
 * OWNER, so an admin-owned session token used to pass `isAdmin(user)` and
 * read/write instance settings; and SettingsError carried no status, so every
 * denial surfaced as a 500 instead of a 403. Both gates are asserted here:
 * role (non-admin cookie -> 403) AND actor (any bearer -> 403, not 500).
 * `errorHandlerPlugin` is mounted so denials serialize like production.
 */

const app = new Elysia().use(errorHandlerPlugin).use(settingsRoutes);

describe("settings routes (admin cookie only)", () => {
  let adminId: string;
  const adminEmail = `settings-admin-${crypto.randomUUID()}@mote.local`;
  const adminPassword = "settings-admin-pass-1";
  let nonAdminId: string;
  const nonAdminEmail = `settings-user-${crypto.randomUUID()}@mote.local`;
  const nonAdminPassword = "settings-user-pass-1";
  let adminCookie: string;
  let nonAdminCookie: string;
  let adminSessionKey: string;
  let systemKey: string;
  let sessionId: string;
  const createdKeyIds: string[] = [];

  /** Bearer-authenticated request against the settings routes. */
  function bearerRequest(path: string, key: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return new Request(`http://localhost:3080${path}`, { ...init, headers });
  }

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    adminId = await users.createUser({
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
    });
    nonAdminId = await users.createUser({
      email: nonAdminEmail,
      passwordHash: await hashPassword(nonAdminPassword),
      role: "user",
    });
    adminCookie = await signIn(adminEmail, adminPassword);
    nonAdminCookie = await signIn(nonAdminEmail, nonAdminPassword);

    // A session OWNED BY THE ADMIN, with its real MCP token: the exact
    // credential that used to inherit the admin's settings rights.
    sessionId = crypto.randomUUID();
    await new SessionsRepository(db).create({
      id: sessionId,
      userId: adminId,
      profileId: "p",
      harnessId: "claude-code",
      name: "settings-token-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminSessionKey = await issueSessionToken(sessionId, adminId);
    const row = await new SessionsRepository(db).findById(sessionId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);

    const created = (await auth.api.createApiKey({
      body: { name: "settings-sys-test", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    systemKey = created.key;
  });

  afterAll(async () => {
    // Restore the instance-wide default this suite toggles, then drop fixtures.
    await new SettingsRepository(db).set("allow_registrations", true);
    await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", nonAdminId).execute();
    await deleteUserByEmailOrId(adminEmail);
    await deleteUserByEmailOrId(nonAdminEmail);
  });

  it("anonymous -> 401", async () => {
    expect((await app.fetch(new Request("http://localhost:3080/api/settings"))).status).toBe(401);
  });

  it("admin cookie reads and writes settings (200)", async () => {
    const get = await app.fetch(authedRequest("/api/settings", adminCookie));
    expect(get.status).toBe(200);
    const before = (await get.json()) as { allowRegistrations: boolean };
    expect(typeof before.allowRegistrations).toBe("boolean");

    const patch = await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: false }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { allowRegistrations: boolean }).allowRegistrations).toBe(false);

    const restore = await app.fetch(
      authedRequest("/api/settings", adminCookie, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: true }),
      }),
    );
    expect(restore.status).toBe(200);
    expect(((await restore.json()) as { allowRegistrations: boolean }).allowRegistrations).toBe(true);
  });

  it("non-admin cookie PATCH -> 403 with a 403 body (not the old statusless 500)", async () => {
    const res = await app.fetch(
      authedRequest("/api/settings", nonAdminCookie, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: false }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.statusCode).toBe(403);
    expect((await app.fetch(authedRequest("/api/settings", nonAdminCookie))).status).toBe(403);
  });

  it("admin-owned session token is rejected on GET and PATCH (403, not 500)", async () => {
    const get = await app.fetch(bearerRequest("/api/settings", adminSessionKey));
    expect(get.status).toBe(403);
    const patch = await app.fetch(
      bearerRequest("/api/settings", adminSessionKey, {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: false }),
      }),
    );
    expect(patch.status).toBe(403);
    const body = (await patch.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.statusCode).toBe(403);
    // The setting is untouched: the denial was real, not a serialization mask.
    const now = await new SettingsRepository(db).get("allow_registrations", true);
    expect(now).toBe(true);
  });

  it("system key is rejected on GET and PATCH (403)", async () => {
    expect((await app.fetch(bearerRequest("/api/settings", systemKey))).status).toBe(403);
    expect(
      (
        await app.fetch(
          bearerRequest("/api/settings", systemKey, {
            method: "PATCH",
            body: JSON.stringify({ allowRegistrations: false }),
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("public GET stays as-is (no admin/cookie gate added)", async () => {
    // /public is the registration-visibility read at the top of the file; the
    // fix must not touch it: it keeps answering through authGuard (401 for
    // anonymous today) and 200 for any authenticated actor, bearer included.
    const anon = await app.fetch(new Request("http://localhost:3080/api/settings/public"));
    expect(anon.status).toBe(401);
    const viaSessionKey = await app.fetch(bearerRequest("/api/settings/public", adminSessionKey));
    expect(viaSessionKey.status).toBe(200);
  });

  it("GET /public reports emergencyLoginActive around the env var", async () => {
    // /public answers behind authGuard (401 anonymous — pinned by the test
    // above), so the flag reads go out with the admin cookie; the banner's
    // real caller is always a signed-in user anyway.
    type Public = { allowRegistrations: boolean; emergencyLoginActive: boolean };
    const saved = process.env.MOTE_EMERGENCY_PASSWORD;
    const get = async () =>
      (await (
        await app.fetch(
          new Request("http://localhost:3080/api/settings/public", {
            headers: { cookie: `better-auth.session_token=${adminCookie}` },
          }),
        )
      ).json()) as Public;
    try {
      delete process.env.MOTE_EMERGENCY_PASSWORD;
      const off = await get();
      expect(off.emergencyLoginActive).toBe(false);
      process.env.MOTE_EMERGENCY_PASSWORD = "armed-for-test";
      const on = await get();
      expect(on.emergencyLoginActive).toBe(true);
      expect(on.allowRegistrations).toBe(off.allowRegistrations);
      // Whitespace-only must read as DISARMED (the hatch itself refuses to
      // arm on it — a " " break-glass password is no password).
      process.env.MOTE_EMERGENCY_PASSWORD = "   ";
      expect((await get()).emergencyLoginActive).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MOTE_EMERGENCY_PASSWORD;
      else process.env.MOTE_EMERGENCY_PASSWORD = saved;
    }
  });

  it("GET /public reports appBaseUrl === APP_BASE_URL (Nodes dialog renders the install command from it)", async () => {
    // Spec 2026-08-31 Phase 3: the dialog must bake the SERVER-side base URL,
    // not window.location.origin — the browser may reach the instance through
    // a name the node cannot dial. The value is already public: the keyless
    // install.sh usage script embeds the same constant.
    const res = await app.fetch(authedRequest("/api/settings/public", adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      allowRegistrations: boolean;
      emergencyLoginActive: boolean;
      appBaseUrl: string;
    };
    expect(body.appBaseUrl).toBe(APP_BASE_URL);
  });
});
