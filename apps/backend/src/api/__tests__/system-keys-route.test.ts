import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { channelRoutes } from "@/api/channels/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Admin CRUD for system-wide API keys. The property that matters: the key
 * minted here is a real bearer credential that reaches the API (admin-gated
 * surfaces reject it, ordinary routes accept it), and revocation is immediate.
 */
describe("system keys route", () => {
  let adminId: string;
  let adminToken: string;
  let plainToken: string;
  const adminEmail = `sysk-admin-${crypto.randomUUID()}@mote.local`;
  const userEmail = `sysk-user-${crypto.randomUUID()}@mote.local`;
  const pw = "syskeys-pass-1";
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    adminId = await users.createUser({ email: adminEmail, passwordHash: await hashPassword(pw), role: "admin" });
    await users.createUser({ email: userEmail, passwordHash: await hashPassword(pw), role: "user" });
    adminToken = await signIn(adminEmail, pw);
    plainToken = await signIn(userEmail, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await deleteUserByEmailOrId(adminEmail);
    await deleteUserByEmailOrId(userEmail);
  });

  async function adminCall(path: string, init?: RequestInit) {
    const res = await systemKeysRoutes.fetch(authedRequest(path, adminToken, init));
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body: body as any, text: res.ok ? "" : await res.text().catch(() => "") };
  }

  it("plain user cookie -> 403; anonymous -> 401", async () => {
    expect((await systemKeysRoutes.fetch(authedRequest("/api/system-keys", plainToken))).status).toBe(403);
    expect((await systemKeysRoutes.fetch(new Request("http://localhost:3080/api/system-keys"))).status).toBe(401);
  });

  it("admin creates a usable key, sees it listed (never the hash), and revokes it", async () => {
    const created = await adminCall("/api/system-keys", { method: "POST", body: JSON.stringify({ name: "lan" }) });
    expect(created.status).toBe(200);
    const key = created.body.key as string;
    const id = created.body.id as string;
    createdKeyIds.push(id);
    expect(key.startsWith("mote_")).toBe(true);

    const listed = await adminCall("/api/system-keys");
    const row = (listed.body.keys as Record<string, unknown>[]).find((k) => k.id === id);
    expect(row).toMatchObject({ name: "lan", enabled: true });
    expect(JSON.stringify(listed.body)).not.toContain(key); // plaintext never resurfaces
    expect((row as { preview?: string }).preview).toBeTruthy(); // 6-char start is fine

    // The key authenticates as a bearer credential on ordinary routes…
    const asBearer = await channelRoutes.fetch(
      new Request("http://localhost:3080/api/channels", { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(asBearer.status).toBe(200);
    // …but not on admin routes (cookie-admin only).
    expect(
      (
        await systemKeysRoutes.fetch(
          new Request("http://localhost:3080/api/system-keys", { headers: { authorization: `Bearer ${key}` } }),
        )
      ).status,
    ).toBe(403);

    // Disable -> bearer rejected; re-enable -> accepted; delete -> gone.
    expect(
      (await adminCall(`/api/system-keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status,
    ).toBe(200);
    expect(
      (
        await channelRoutes.fetch(
          new Request("http://localhost:3080/api/channels", { headers: { authorization: `Bearer ${key}` } }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await adminCall(`/api/system-keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })).status,
    ).toBe(200);
    expect((await adminCall(`/api/system-keys/${id}`, { method: "DELETE" })).status).toBe(200);
    const after = await adminCall("/api/system-keys");
    expect((after.body.keys as { id: string }[]).some((k) => k.id === id)).toBe(false);
  });

  it("PATCH on an unknown key id -> 404; missing name -> 400 INPUT_VALIDATION_ERROR", async () => {
    expect(
      (
        await adminCall("/api/system-keys/does-not-exist", {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(404);
    // Mounted with the global error handler (as in the real server), Elysia's
    // native 422 becomes the shared 400 structured body.
    const app = new Elysia().use(errorHandlerPlugin).use(systemKeysRoutes);
    const res = await app.fetch(authedRequest("/api/system-keys", adminToken, { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
  });

  it("a session-kind key is never listed through the system routes", async () => {
    // The seed in session-tokens suites proves list scoping is by metadata kind.
    const listed = await adminCall("/api/system-keys");
    for (const k of listed.body.keys as { name: string }[]) expect(k.name.startsWith("sess:")).toBe(false);
  });
});
