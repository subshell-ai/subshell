import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ExpoPushTicket } from "expo-server-sdk";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import { NotificationsRepository } from "@/db/repositories/notifications.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { ExpoPushMessage } from "@/services/expo-push.js";
import { createNotifyService, type PushSender } from "@/services/notify.service.js";

/**
 * Device fan-out over the SHARED per-process test DB (setupAuthTables runs the
 * real migration chain, so `device_tokens` and `alive` both exist — the scratch
 * 0001+0014 schema used by notify.service.test.ts has neither). Rows are
 * isolated by a per-file random userId and cleaned up in afterAll; the DB is
 * never assumed empty.
 */
const uid = crypto.randomUUID();
const userId = `device-user-${uid}`;
const subshellIds: string[] = [];
const tokens: string[] = [];

async function seedSubshell(id: string, opts: { notify?: boolean; waitingSince?: string | null } = {}) {
  subshellIds.push(id);
  await new SubshellsRepository(db).create({
    id,
    userId,
    profileId: "p",
    harnessId: "h",
    name: "resume-verify",
    workingDir: "/tmp/private/work",
    tmuxSocket: null,
  });
  await db
    .updateTable("subshells")
    .set({ notify: opts.notify ? 1 : 0, waitingSince: opts.waitingSince ?? null })
    .where("id", "=", id)
    .execute();
}

async function enroll(token: string) {
  tokens.push(token);
  await new DeviceTokensRepository(db).upsertForUser(userId, token, "ios");
}

const okTickets = (n: number): ExpoPushTicket[] =>
  Array.from({ length: n }, (_, i) => ({ status: "ok", id: `t${i}` }) as unknown as ExpoPushTicket);

const neverWeb: PushSender = async () => ({ statusCode: 201 });

function services(
  record: { calls: ExpoPushMessage[][] },
  mode?: "throw" | ((msgs: ExpoPushMessage[]) => ExpoPushTicket[]),
) {
  const devices = new DeviceTokensRepository(db);
  const svc = createNotifyService({
    subshells: db,
    subs: new NotificationsRepository(db),
    devices,
    sender: neverWeb,
    expoSender: async (msgs) => {
      record.calls.push(msgs);
      if (mode === "throw") throw new Error("network down");
      return mode ? mode(msgs) : okTickets(msgs.length);
    },
    vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
  });
  return { svc, devices };
}

const sentFor = (rec: { calls: ExpoPushMessage[][] }, sid: string) =>
  rec.calls.flat().filter((m) => m.data.sid === sid);

describe("notifySubshell — device fan-out", () => {
  beforeAll(async () => {
    await setupAuthTables(); // real migrations → device_tokens + alive exist
  });

  afterAll(async () => {
    for (const id of subshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const t of tokens) await db.deleteFrom("deviceTokens").where("token", "=", t).execute();
    await db.deleteFrom("notificationsSubscriptions").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(userId); // no user row was created; uniform cleanup no-op
  });

  it("stays silent unless the bell is on", async () => {
    await seedSubshell(`${uid}-off`, { notify: false });
    await enroll(`ExponentPushToken[off${uid.slice(0, 8)}]`);
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySubshell(`${uid}-off`, "turn_complete");
    expect(sentFor(rec, `${uid}-off`)).toHaveLength(0);
  });

  it("rings devices even when the user has NO web subscriptions", async () => {
    // Regression pin for the old `if (subs.length === 0) return` early-exit:
    // the device fan-out must be independent of web-sub presence.
    await seedSubshell(`${uid}-nosubs`, { notify: true });
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySubshell(`${uid}-nosubs`, "turn_complete");
    expect(sentFor(rec, `${uid}-nosubs`).length).toBeGreaterThan(0);
    expect(sentFor(rec, `${uid}-nosubs`)[0]).toMatchObject({
      title: "subshell",
      threadId: `${uid}-nosubs`,
      data: { sid: `${uid}-nosubs`, kind: "turn_complete" },
    });
  });

  it("fans out only to the subshell owner's devices", async () => {
    // Service-level pin for spec §Testing "owner-only fan-out" — the repository
    // proves listByUser scoping, but nothing pinned THIS path until now.
    await seedSubshell(`${uid}-owneronly`, { notify: true });
    await enroll(`ExponentPushToken[mine${uid.slice(0, 8)}]`);
    const otherTok = `ExponentPushToken[other${uid.slice(0, 8)}]`;
    await new DeviceTokensRepository(db).upsertForUser(crypto.randomUUID(), otherTok, "android");
    try {
      const rec = { calls: [] as ExpoPushMessage[][] };
      const { svc } = services(rec);
      await svc.notifySubshell(`${uid}-owneronly`, "turn_complete");
      const msgs = sentFor(rec, `${uid}-owneronly`);
      expect(msgs.length).toBeGreaterThan(0); // not a vacuous pass
      expect(msgs.map((m) => m.to)).not.toContain(otherTok);
    } finally {
      await db.deleteFrom("deviceTokens").where("token", "=", otherTok).execute();
    }
  });

  it("never carries a name, path or operator text to the relay", async () => {
    await seedSubshell(`${uid}-privacy`, { notify: true });
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySubshell(`${uid}-privacy`, "turn_complete");
    const wire = JSON.stringify(sentFor(rec, `${uid}-privacy`));
    expect(wire.length).toBeGreaterThan(10);
    expect(wire).not.toContain("resume-verify");
    expect(wire).not.toContain("/tmp/private/work");
  });

  it("prunes DeviceNotRegistered tickets; keeps other errors and transient throws", async () => {
    await seedSubshell(`${uid}-prune`, { notify: true });
    const deadTok = `ExponentPushToken[dead${uid.slice(0, 8)}]`;
    const oursTok = `ExponentPushToken[ours${uid.slice(0, 8)}]`;
    await enroll(deadTok);
    await enroll(oursTok);
    const errTicket = (error: string): ExpoPushTicket =>
      ({ status: "error", message: error, details: { error } }) as unknown as ExpoPushTicket;
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc, devices } = services(rec, (msgs) =>
      msgs.map((m) => errTicket(m.to === deadTok ? "DeviceNotRegistered" : "MessageTooBig")),
    );
    await svc.notifySubshell(`${uid}-prune`, "turn_complete");
    const left = (await devices.listByUser(userId)).map((r) => r.token);
    expect(left).not.toContain(deadTok); // relay says the device is gone
    expect(left).toContain(oursTok); // our-bug ticket keeps the row

    await seedSubshell(`${uid}-throw`, { notify: true });
    const keepTok = `ExponentPushToken[keep${uid.slice(0, 8)}]`;
    await enroll(keepTok);
    const rec2 = { calls: [] as ExpoPushMessage[][] };
    const s2 = services(rec2, "throw");
    await s2.svc.notifySubshell(`${uid}-throw`, "turn_complete");
    const stillLeft = (await s2.devices.listByUser(userId)).map((r) => r.token);
    expect(stillLeft).toContain(keepTok); // transport exception = transient: rows survive
    expect(stillLeft).toContain(oursTok);
  });

  it("prunes junk-token rows and sends only to real ones", async () => {
    await seedSubshell(`${uid}-junk`, { notify: true });
    const junkTok = `https://junk.example/${uid}`;
    const realTok = `ExponentPushToken[real${uid.slice(0, 8)}]`;
    tokens.push(junkTok);
    await db.insertInto("deviceTokens").values({
      id: crypto.randomUUID(),
      userId,
      token: junkTok,
      platform: "ios",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await enroll(realTok);
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc, devices } = services(rec);
    await svc.notifySubshell(`${uid}-junk`, "turn_complete");
    const sent = sentFor(rec, `${uid}-junk`).map((m) => m.to);
    expect(sent).toContain(realTok);
    expect(sent).not.toContain(junkTok);
    expect((await devices.listByUser(userId)).map((r) => r.token)).not.toContain(junkTok);
  });

  it("badges the watcher-order +1, then settles once the stamp lands", async () => {
    const subject = `${uid}-badge`;
    // Exact arithmetic holds because no OTHER test in this file stamps a waiting
    // row: waiting = {w1, w2} here; the dead row is never counted.
    await seedSubshell(subject, { notify: true, waitingSince: null }); // not stamped (watcher order)
    await seedSubshell(`${uid}-w1`, { notify: true, waitingSince: "2026-08-31T00:00:00.000Z" });
    await seedSubshell(`${uid}-w2`, { notify: true, waitingSince: "2026-08-31T00:00:00.000Z" });
    await seedSubshell(`${uid}-dead`, { notify: true, waitingSince: "2026-08-31T00:00:00.000Z" });
    await db.updateTable("subshells").set({ alive: 0 }).where("id", "=", `${uid}-dead`).execute();
    const rec = { calls: [] as ExpoPushMessage[][] };
    const { svc } = services(rec);
    await svc.notifySubshell(subject, "turn_complete");
    expect(sentFor(rec, subject)[0]?.badge).toBe(3); // 2 waiting + this one about to stamp
    await db
      .updateTable("subshells")
      .set({ waitingSince: "2026-08-31T00:00:01.000Z" })
      .where("id", "=", subject)
      .execute();
    await svc.notifySubshell(subject, "needs_attention");
    expect(sentFor(rec, subject).at(-1)?.badge).toBe(3); // already inside the count: no double-bump
  });

  it("a service built WITHOUT the device transport never touches it (legacy pin)", async () => {
    await seedSubshell(`${uid}-legacy`, { notify: true });
    const hits: string[] = [];
    let expoCalled = false;
    await new NotificationsRepository(db).upsertForUser(userId, `https://push/legacy-${uid}`, "k", "a");
    const svc = createNotifyService({
      subshells: db,
      subs: new NotificationsRepository(db),
      sender: async (sub) => {
        hits.push(sub.endpoint);
        return { statusCode: 201 };
      },
      expoSender: async () => {
        expoCalled = true;
        return okTickets(1);
      },
      vapid: { publicKey: "pk", privateKey: "sk", subject: "mailto:x@x" },
      // devices: intentionally absent — the pre-mobile shape from notify.service.test.ts.
    });
    await svc.notifySubshell(`${uid}-legacy`, "turn_complete");
    expect(hits).toContain(`https://push/legacy-${uid}`);
    expect(expoCalled).toBe(false); // no repo → no fan-out even with a sender present
  });
});
