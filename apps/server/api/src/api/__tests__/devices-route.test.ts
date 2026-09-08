import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { devicesRoutes } from "@/api/devices.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { __setVapidDirForTests } from "@/services/notify.service.js";

// errorHandlerPlugin mounted like createApp() so thrown status errors and
// validation failures serialize like production (400, not Elysia's raw 422).
const app = new Elysia().use(errorHandlerPlugin).use(devicesRoutes);
const json = (b: unknown) => JSON.stringify(b);

describe("devices route", () => {
  const email = `devices-${crypto.randomUUID()}@subshell.local`;
  const password = "devices-pass-1234";
  const otherEmail = `devices-other-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let cookie: string;
  let otherUserId: string;
  let otherCookie: string;
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables(); // runs the REAL migrations — device_tokens exists via the 0015 map entry
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
    otherUserId = await new UsersRepository(db).createUser({
      email: otherEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    otherCookie = await signIn(otherEmail, password);
  });

  afterAll(async () => {
    for (const uid of [userId, otherUserId]) await db.deleteFrom("deviceTokens").where("userId", "=", uid).execute();
    for (const kid of createdKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(otherEmail);
  });

  function req(path: string, init?: RequestInit, session?: string) {
    const headers = new Headers(init?.headers);
    if (session) headers.set("cookie", `better-auth.session_token=${session}`);
    return app.fetch(new Request(`http://localhost:3080/api/devices${path}`, { ...init, headers }));
  }
  const enrollBody = (token = "ExponentPushToken[TestToken0001]") => json({ token, platform: "ios" });
  const postBody = (token?: string) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: enrollBody(token),
  });

  async function mintSystemKey(): Promise<string> {
    const created = (await getAuth().api.createApiKey({
      body: { name: "devices-test-system", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    return created.key;
  }

  it("POST enrolls a cookie actor's device and owns the row", async () => {
    const res = await req("/", postBody(), cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await new DeviceTokensRepository(db).listByUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "ios", token: "ExponentPushToken[TestToken0001]" });
  });

  it("rejects a system bearer key with 403 and stores nothing", async () => {
    const key = await mintSystemKey();
    const res = await req("/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: enrollBody("ExponentPushToken[BearerNope001]"),
    });
    expect(res.status).toBe(403);
    expect(await new DeviceTokensRepository(db).listByUser(userId)).toHaveLength(1); // unchanged
  });

  it("rejects anonymous with 401 and malformed bodies with 400", async () => {
    const anon = await req("/", postBody("ExponentPushToken[AnonNope0001]"));
    expect(anon.status).toBe(401);
    const short = await req(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: json({ token: "x", platform: "ios" }) },
      cookie,
    );
    expect(short.status).toBe(400);
    const plat = await req(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ token: "ExponentPushToken[OkOkOk0001]", platform: "symbian" }),
      },
      cookie,
    );
    expect(plat.status).toBe(400);
  });

  it("DELETE is owner-scoped and idempotent", async () => {
    await req("/", postBody("ExponentPushToken[DelMe000001]"), cookie);
    const wrong = await req(
      "/",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: json({ token: "ExponentPushToken[DelMe000001]" }),
      },
      otherCookie,
    );
    expect(wrong.status).toBe(200);
    expect(await new DeviceTokensRepository(db).listByUser(userId)).toHaveLength(2);
    const mine = await req(
      "/",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: json({ token: "ExponentPushToken[DelMe000001]" }),
      },
      cookie,
    );
    expect(mine.status).toBe(200);
    const again = await req(
      "/",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: json({ token: "ExponentPushToken[DelMe000001]" }),
      },
      cookie,
    );
    expect(again.status).toBe(200); // idempotent
    expect(await new DeviceTokensRepository(db).listByUser(userId)).toHaveLength(1);
  });

  it("enrolls even when VAPID is unconfigured — the Expo transport is independent", async () => {
    __setVapidDirForTests("/proc/subshell-definitely-not-writable");
    try {
      const res = await req("/", postBody("ExponentPushToken[NoVapid0001]"), cookie);
      expect(res.status).toBe(200);
    } finally {
      __setVapidDirForTests(null);
    }
  });
});
