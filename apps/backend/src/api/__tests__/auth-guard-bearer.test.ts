import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { authGuard, ForbiddenError, requireAdmin, requirePerm } from "@/api/auth-guard.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authPlugin } from "@/plugins/auth.plugin.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The bearer half of authGuard: API keys (system + session) authenticate the
 * same routes as cookies, and each kind yields a distinct principal/actor.
 * The cookie path must regress untouched — existing suites cover it broadly;
 * the probe assertions here pin the new context fields for both paths.
 */

interface ProbeCtx {
  user: { id: string };
  principal: string;
  actor: string;
  apiKeyId: string | null;
  apiKeyPermissions: Record<string, string[]> | null;
}

/** The probe route's JSON response (flattened view of ProbeCtx). */
interface ProbeResponse {
  userId: string;
  principal: string;
  actor: string;
  apiKeyId: string | null;
  perms: Record<string, string[]> | null;
}

const probe = new Elysia().use(authGuard).get("/probe", (c) => {
  const ctx = c as unknown as ProbeCtx;
  return {
    userId: ctx.user.id,
    principal: ctx.principal,
    actor: ctx.actor,
    apiKeyId: ctx.apiKeyId,
    perms: ctx.apiKeyPermissions,
  };
});

const adminProbe = new Elysia().use(requireAdmin).get("/admin-probe", () => ({ ok: true }));

describe("authGuard bearer path", () => {
  let userId: string;
  let adminId: string;
  let plainToken: string;
  const email = `guard-${crypto.randomUUID()}@mote.local`;
  const adminEmail = `guard-admin-${crypto.randomUUID()}@mote.local`;
  const password = "guard-pass-1234";
  const createdSessionIds: string[] = [];
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    userId = await users.createUser({ email, passwordHash: await hashPassword(password), role: "user" });
    adminId = await users.createUser({ email: adminEmail, passwordHash: await hashPassword(password), role: "admin" });
    plainToken = await signIn(email, password);
  });

  afterAll(async () => {
    for (const sid of createdSessionIds) await db.deleteFrom("sessions").where("id", "=", sid).execute();
    // remove the api keys minted here (raw table, plugin owns it)
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(adminEmail);
  });

  /** Bearer-GETs the probe. */
  async function bearerGet(key: string) {
    const res = await probe.fetch(
      new Request("http://localhost:3080/probe", { headers: { authorization: `Bearer ${key}` } }),
    );
    return { status: res.status, body: res.ok ? ((await res.json()) as ProbeResponse) : null };
  }

  async function makeSession(): Promise<string> {
    const id = crypto.randomUUID();
    createdSessionIds.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "guard-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    return id;
  }

  it("cookie path still works and reports cookie actor", async () => {
    const res = await probe.fetch(authedRequest("/probe", plainToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeResponse;
    expect(body.userId).toBe(userId);
    expect(body.actor).toBe("cookie");
    expect(body.principal).toBe(`user:${userId}`);
    expect(body.perms).toBeNull();
  });

  it("anonymous -> 401, garbage bearer -> 401", async () => {
    expect((await probe.fetch(new Request("http://localhost:3080/probe"))).status).toBe(401);
    expect((await bearerGet("mote_not-a-real-key")).status).toBe(401);
  });

  it("system key bearer authenticates as its owning (system) user", async () => {
    const systemUserId = await ensureSystemUser();
    const created = (await auth.api.createApiKey({
      body: { name: "sys-test", userId: systemUserId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    const { status, body } = await bearerGet(created.key);
    expect(status).toBe(200);
    expect(body?.actor).toBe("system-key");
    expect(body?.principal).toBe(`user:${systemUserId}`);
    expect(body?.apiKeyId).toBe(created.id);
    expect(body?.perms).toBeNull(); // system keys are unrestricted by design
  });

  it("a self-minted key cannot forge a session principal or a system actor", async () => {
    // The plugin's create endpoint accepts arbitrary metadata, so the GUARD
    // must distrust it: session-kind requires the server-written apiKeyId
    // link; system actor requires the system user's ownership.
    const sid = await makeSession();
    const legit = await issueSessionToken(sid, userId);
    const row = await new SessionsRepository(db).findById(sid);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    expect((await bearerGet(legit)).status).toBe(200); // control: the real token works

    const forged = (await auth.api.createApiKey({
      body: { name: "forged", userId, metadata: { kind: "session", sessionId: sid } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(forged.id);
    expect((await bearerGet(forged.key)).status).toBe(401); // never linked to the session

    const fakeSystem = (await auth.api.createApiKey({
      body: { name: "fake-system", userId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(fakeSystem.id);
    // Owned by a normal user, not the system user → not a system actor.
    expect((await bearerGet(fakeSystem.key)).status).toBe(401);
  });

  it("the plugin's self-service api-key endpoints are blocked", async () => {
    const res = await authPlugin.fetch(
      authedRequest("/api/auth/api-key/create", plainToken, { method: "POST", body: JSON.stringify({ name: "x" }) }),
    );
    expect(res.status).toBe(403);
  });

  it("session key bearer yields sess principal and its permissions", async () => {
    const sid = await makeSession();
    const key = await issueSessionToken(sid, userId);
    const row = await new SessionsRepository(db).findById(sid);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    const { status, body } = await bearerGet(key);
    expect(status).toBe(200);
    expect(body?.actor).toBe("session-key");
    expect(body?.principal).toBe(`sess:${sid}`);
    expect(body?.userId).toBe(userId); // routes keep working via the OWNER's id
    expect(body?.perms).toMatchObject({ channels: ["read", "write"], sessions: ["read", "write"] });
  });

  it("session key whose session row is gone -> 401", async () => {
    const sid = await makeSession();
    const key = await issueSessionToken(sid, userId);
    const row = await new SessionsRepository(db).findById(sid);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    await db.deleteFrom("sessions").where("id", "=", sid).execute();
    expect((await bearerGet(key)).status).toBe(401);
  });

  it("session key whose apiKeyId link was unlinked -> 401 (real guard)", async () => {
    // M-4c (final review): the lifecycle wave's revoke-failure fallback does
    // exactly this write (`sessions.update(id, { apiKeyId: null })`). The key
    // still verifies at the plugin level — only the guard's link check makes
    // the unlink neutralise it, and until now that chain was argued by code
    // reading only.
    const sid = await makeSession();
    const key = await issueSessionToken(sid, userId);
    const row = await new SessionsRepository(db).findById(sid);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    expect((await bearerGet(key)).status).toBe(200); // control: linked key passes
    await new SessionsRepository(db).update(sid, { apiKeyId: null });
    expect((await bearerGet(key)).status).toBe(401);
  });

  it("requirePerm allows cookie/system actors, enforces session-key grants", () => {
    expect(() => requirePerm({ actor: "cookie", apiKeyPermissions: null }, "channels", "read")).not.toThrow();
    expect(() => requirePerm({ actor: "system-key", apiKeyPermissions: null }, "sessions", "write")).not.toThrow();
    expect(() =>
      requirePerm({ actor: "session-key", apiKeyPermissions: { channels: ["read"] } }, "channels", "read"),
    ).not.toThrow();
    expect(() =>
      requirePerm({ actor: "session-key", apiKeyPermissions: { channels: ["read"] } }, "channels", "write"),
    ).toThrow(ForbiddenError);
    expect(() =>
      requirePerm({ actor: "session-key", apiKeyPermissions: { channels: ["read"] } }, "sessions", "read"),
    ).toThrow(ForbiddenError);
  });

  it("requireAdmin rejects bearer actors (cookie-admin only)", async () => {
    const adminToken = await signIn(adminEmail, password);
    expect((await adminProbe.fetch(authedRequest("/admin-probe", adminToken))).status).toBe(200);
    // a plain user's cookie is 403, a system-key bearer is 403 too (not cookie)
    expect((await adminProbe.fetch(authedRequest("/admin-probe", plainToken))).status).toBe(403);
    const created = (await auth.api.createApiKey({
      body: { name: "sys-admin-test", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    const res = await adminProbe.fetch(
      new Request("http://localhost:3080/admin-probe", { headers: { authorization: `Bearer ${created.key}` } }),
    );
    expect(res.status).toBe(403);
  });
});
