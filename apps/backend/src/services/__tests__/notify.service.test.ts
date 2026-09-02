import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as notificationsMigration from "@/db/migrations/0014-session-notifications.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import type { Database } from "@/db/types/index.js";
import {
  __setVapidDirForTests,
  buildNotificationPayload,
  createNotifyService,
  type PushSender,
} from "@/services/notify.service.js";

async function freshDb() {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await notificationsMigration.up(db as Kysely<any>);
  // user_meta.notify_enabled — read by the master-switch gate in notifySession.
  await sharingMigration.up(db as Kysely<any>);
  return db;
}

function sender(record: { to: string[] }): PushSender {
  return async (sub) => {
    record.to.push(sub.endpoint);
    return { statusCode: 201 };
  };
}

describe("buildNotificationPayload", () => {
  it("maps each kind to its copy and always targets the session url with a session tag", () => {
    const p = buildNotificationPayload({ id: "sid", name: "resume-verify" }, "turn_complete");
    expect(p).toEqual({
      title: "resume-verify",
      body: "Done — waiting for you",
      url: "/sessions/sid",
      tag: "sid",
    });
    expect(buildNotificationPayload({ id: "s", name: "x" }, "needs_attention").body).toBe("Needs your approval");
    expect(buildNotificationPayload({ id: "s", name: "x" }, "exited").body).toBe("Session exited");
    expect(buildNotificationPayload({ id: "s", name: "x" }, "crashed").body).toBe("Crashed — auto-restarting");
    // Exhausted backoff: the bare truth, no restart promised (final-review fix).
    expect(buildNotificationPayload({ id: "s", name: "x" }, "crashed_final").body).toBe("Crashed");
  });
});

describe("notifySession", () => {
  it("stays silent unless the session's bell is on", async () => {
    const db = await freshDb();
    // Cast like the migrations above: the scratch schema (0001 + 0014)
    // lacks the mid-history liveness columns the full `SessionTable` type
    // demands, but every column this insert needs exists.
    await (db as Kysely<any>)
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u1", "https://push/a", "k", "a");
    const hits: { to: string[] } = { to: [] };
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: sender(hits),
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual([]); // bell off → nothing sent
    await db.updateTable("sessions").set({ notify: 1 }).where("id", "=", "s1").execute();
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual(["https://push/a"]);
    await db.destroy();
  });

  it("stays silent when the owner's per-user master switch is off, even with the bell on", async () => {
    const db = await freshDb();
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "u1", role: "user", notifyEnabled: 0 }).execute();
    await (db as Kysely<any>)
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
        notify: 1,
      })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u1", "https://push/a", "k", "a");
    const hits: { to: string[] } = { to: [] };
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: sender(hits),
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual([]); // master off → total silence regardless of the bell
    // Flipping the switch back on resumes the ring (no restart of the service).
    await (db as Kysely<any>).updateTable("userMeta").set({ notifyEnabled: 1 }).where("userId", "=", "u1").execute();
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual(["https://push/a"]);
    await db.destroy();
  });

  it("prunes subscriptions whose endpoint 403/404/410s, keeps others", async () => {
    const db = await freshDb();
    await (db as Kysely<any>)
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
        notify: 1,
      })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u1", "https://push/dead", "k", "a");
    await repo.upsertForUser("u1", "https://push/badjwt", "k", "a");
    await repo.upsertForUser("u1", "https://push/alive", "k", "a");
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: async (sub) => {
        if (sub.endpoint.endsWith("dead")) throw Object.assign(new Error("gone"), { statusCode: 410 });
        // A 403 means the gateway rejects our VAPID JWT for THIS subscription —
        // the binding (the server key chosen at subscribe time) no longer
        // matches what we sign with. Permanent; retrying never heals.
        if (sub.endpoint.endsWith("badjwt"))
          throw Object.assign(new Error("forbidden"), { statusCode: 403, body: '{"reason":"BadJwtToken"}' });
        return { statusCode: 201 };
      },
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "exited");
    expect((await repo.listByUser("u1")).map((s) => s.endpoint)).toEqual(["https://push/alive"]);
    await db.destroy();
  });

  it("keeps the subscription when the sender throws a transient (non-404/410) error", async () => {
    // The prune branch is deliberately narrow (web-push's 404/410 = gone);
    // everything else — here a 500 — is transient: the row must survive so
    // the next event can still reach the device.
    const db = await freshDb();
    await (db as Kysely<any>)
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
        notify: 1,
      })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u1", "https://push/flaky", "k", "a");
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: async () => {
        throw Object.assign(new Error("server error"), { statusCode: 500 });
      },
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "turn_complete");
    expect((await repo.listByUser("u1")).map((s) => s.endpoint)).toEqual(["https://push/flaky"]);
    await db.destroy();
  });

  it("never notifies another user's subscriptions", async () => {
    const db = await freshDb();
    await (db as Kysely<any>)
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
        notify: 1,
      })
      .execute();
    const repo = new NotificationsRepository(db);
    await repo.upsertForUser("u2", "https://push/other", "k", "a");
    const hits: { to: string[] } = { to: [] };
    const svc = createNotifyService({
      sessions: db,
      subs: repo,
      sender: sender(hits),
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
    });
    await svc.notifySession("s1", "turn_complete");
    expect(hits.to).toEqual([]);
    await db.destroy();
  });
});

describe("VAPID key storage", () => {
  afterEach(() => __setVapidDirForTests(null));

  it("regenerates over a vapid.json that lacks the key fields (never serves undefined)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-vapid-"));
    // A truncated/foreign JSON file parses fine but carries no keys — the
    // old code served those undefined straight into /config (a
    // response-schema violation). A corrupt key file is already unusable,
    // so regeneration is the honest repair.
    writeFileSync(join(dir, "vapid.json"), JSON.stringify({ junk: 1 }));
    __setVapidDirForTests(dir);
    try {
      const db = await freshDb();
      const repo = new NotificationsRepository(db);
      const publicKey = await createNotifyService({ sessions: db, subs: repo }).vapidPublicKey();
      expect(typeof publicKey).toBe("string");
      expect(publicKey.length).toBeGreaterThan(30);
      // The file itself is repaired in place, 0600 write included.
      const saved = JSON.parse(readFileSync(join(dir, "vapid.json"), "utf8")) as Record<string, unknown>;
      expect(typeof saved.publicKey).toBe("string");
      expect((saved.publicKey as string).length).toBeGreaterThan(30);
      expect(typeof saved.privateKey).toBe("string");
      expect((saved.privateKey as string).length).toBeGreaterThan(0);
      await db.destroy();
    } finally {
      __setVapidDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates vapid.json once, then reloads the same pair from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-vapid-"));
    __setVapidDirForTests(dir);
    try {
      const db = await freshDb();
      const repo = new NotificationsRepository(db);
      const first = await createNotifyService({ sessions: db, subs: repo }).vapidPublicKey();
      expect(existsSync(join(dir, "vapid.json"))).toBe(true);
      // Same dir, cleared cache → the pair must come back off the file, unchanged.
      __setVapidDirForTests(dir);
      const second = await createNotifyService({ sessions: db, subs: repo }).vapidPublicKey();
      expect(second).toBe(first);
      await db.destroy();
    } finally {
      __setVapidDirForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
