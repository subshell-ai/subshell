import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { notificationsRoutes } from "@/api/notifications.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { __setVapidDirForTests } from "@/services/notify.service.js";

// errorHandlerPlugin mounted like createApp() so thrown status errors and
// validation failures serialize like production (400, not Elysia's raw 422).
const app = new Elysia().use(errorHandlerPlugin).use(notificationsRoutes);

describe("notifications route", () => {
  const email = `notif-${crypto.randomUUID()}@subshell.local`;
  const password = "notif-pass-1234";
  let cookie: string;
  let userId: string;
  const vapidDir = mkdtempSync(join(tmpdir(), "subshell-vapid-"));
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    __setVapidDirForTests(vapidDir);
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
  });
  afterAll(async () => {
    await db.deleteFrom("notificationsSubscriptions").execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await deleteUserByEmailOrId(email);
    __setVapidDirForTests(null);
    rmSync(vapidDir, { recursive: true, force: true });
  });

  /** Mints a real system key (owned by the `system` service user). */
  async function mintSystemKey(): Promise<string> {
    const created = (await auth.api.createApiKey({
      body: {
        name: "notif-test-system",
        userId: await ensureSystemUser(),
        metadata: { kind: "system" },
      },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    return created.key;
  }

  function req(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", `better-auth.session_token=${cookie}`);
    return app.fetch(new Request(`http://localhost:3080/api/notifications${path}`, { ...init, headers }));
  }
  const json = (b: unknown) => JSON.stringify(b);

  it("GET /config returns the public key and persists vapid.json", async () => {
    const body = (await (await req("/config")).json()) as { publicKey: string; vapidConfigured: boolean };
    expect(body.vapidConfigured).toBe(true);
    expect(body.publicKey.length).toBeGreaterThan(30);
    expect(existsSync(join(vapidDir, "vapid.json"))).toBe(true);
  });

  it("subscribe stores the caller's subscription; unsubscribe removes it", async () => {
    const res = await req("/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({
        endpoint: "https://push/x",
        p256dh: "BFakeP256dhKeyForTests0123456789abcdef",
        auth: "fakeAuthSecret01",
      }),
    });
    expect(res.status).toBe(200);
    const rows = await db.selectFrom("notificationsSubscriptions").selectAll().execute();
    const stored = rows.find((r) => r.endpoint === "https://push/x");
    expect(stored).toBeDefined();
    // The row must belong to the cookie user, not to some other principal.
    expect(stored?.userId).toBe(userId);
    const off = await req("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ endpoint: "https://push/x" }),
    });
    expect(off.status).toBe(200);
    // Unsubscribe must actually delete, not just ack.
    const after = await db.selectFrom("notificationsSubscriptions").selectAll().execute();
    expect(after.map((r) => r.endpoint)).not.toContain("https://push/x");
  });

  it("subscribe validates the body (short endpoint → 400)", async () => {
    const res = await req("/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ endpoint: "", p256dh: "k", auth: "a" }),
    });
    expect(res.status).toBe(400);
  });

  it("unauthenticated → 401", async () => {
    // A request builder that never attaches the cookie — no mutating shared
    // state between tests. /subscribe must be POSTed: a GET there is a router
    // 404 (method mismatch) and never reaches the auth guard.
    const anon = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost:3080/api/notifications${path}`, init));
    expect((await anon("/config")).status).toBe(401);
    expect((await anon("/subscribe", { method: "POST" })).status).toBe(401);
  });

  it("system key bearer → 403 on /config (machine credentials are not browsers)", async () => {
    const key = await mintSystemKey();
    const res = await app.fetch(
      new Request("http://localhost:3080/api/notifications/config", {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("system key bearer → 403 on POST /subscribe (no machine-side enrolling)", async () => {
    const key = await mintSystemKey();
    const res = await app.fetch(
      new Request("http://localhost:3080/api/notifications/subscribe", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: json({
          endpoint: "https://push/machine",
          p256dh: "BFakeP256dhKeyForTests0123456789abcdef",
          auth: "fakeAuthSecret01",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const rows = await db.selectFrom("notificationsSubscriptions").selectAll().execute();
    expect(rows.map((r) => r.endpoint)).not.toContain("https://push/machine");
  });

  it("GET /settings defaults on; PATCH off persists (and works without a preexisting user_meta row)", async () => {
    const on = (await (await req("/settings")).json()) as { notifyEnabled: boolean };
    expect(on.notifyEnabled).toBe(true); // default when unset
    const patched = (await (
      await req("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: json({ notifyEnabled: false }),
      })
    ).json()) as { notifyEnabled: boolean };
    expect(patched.notifyEnabled).toBe(false);
    const reread = (await (await req("/settings")).json()) as { notifyEnabled: boolean };
    expect(reread.notifyEnabled).toBe(false);
    // Restore so no later test sees the switch off.
    await req("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: json({ notifyEnabled: true }),
    });
  });

  it("bearer / machine credential → 403 on GET /settings", async () => {
    const key = await mintSystemKey();
    const res = await app.fetch(
      new Request("http://localhost:3080/api/notifications/settings", { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /subscribe → 503 when VAPID is unconfigured; /unsubscribe stays usable", async () => {
    // The spec's degraded state: an unwritable data dir makes VAPID
    // generation impossible, so enrolling a device must fail as loudly as
    // the feature is quiet elsewhere (503, not a stored-but-never-used
    // subscription). A plain FILE in place of the directory reproduces the
    // mkdirSync failure at any uid — root included, where chmod would not.
    const blocker = join(vapidDir, "blocker-file");
    writeFileSync(blocker, "not a directory");
    __setVapidDirForTests(join(blocker, "nested"));
    try {
      // Sanity: /config's own probe (the source the guard shares) reports
      // the degraded state before subscribe must refuse.
      const cfg = (await (await req("/config")).json()) as { vapidConfigured: boolean };
      expect(cfg.vapidConfigured).toBe(false);

      const res = await req("/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({
          endpoint: "https://push/unconfigured",
          p256dh: "BFakeP256dhKeyForTests0123456789abcdef",
          auth: "fakeAuthSecret01",
        }),
      });
      expect(res.status).toBe(503);
      // The refusal must not store anything either.
      const rows = await db.selectFrom("notificationsSubscriptions").selectAll().execute();
      expect(rows.map((r) => r.endpoint)).not.toContain("https://push/unconfigured");

      // Unsubscribe deliberately carries NO guard: when the config regressed
      // after users subscribed, cleaning up must still be possible.
      const off = await req("/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ endpoint: "https://push/unconfigured" }),
      });
      expect(off.status).toBe(200);
    } finally {
      // Restore the configured temp dir (vapid.json already lives there) so
      // no later test sees the degraded state — __setVapidDirForTests also
      // drops the cached pair, forcing a clean reload.
      __setVapidDirForTests(vapidDir);
      rmSync(blocker, { force: true });
    }
  });
});
