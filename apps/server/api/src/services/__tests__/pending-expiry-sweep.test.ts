import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { setupAuthTables } from "../../api/__tests__/helpers/auth-tables.js";
import {
  expirePendingApprovals,
  expiryDays,
  PENDING_APPROVAL_EXPIRY_KEY,
  remarkUnmarkedArrivals,
} from "../pending-approvals.js";

/**
 * Pending-approval queue housekeeping (spec 2026-09-24 §6): the expiry sweep
 * and the compensating re-mark pass (Task 6 review finding I2).
 *
 * The suite shares one database across files, so every assertion is by
 * FIXTURE ID — a sweep that deletes rows must be pinned by which specific
 * rows survived, not by counts a concurrent file's fixture could move.
 */

const createdUserIds: string[] = [];
const createdDoorIds: string[] = [];
const createdAccountIds: string[] = [];
const createdSessionIds: string[] = [];
const createdVerificationIds: string[] = [];

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

async function makeUser(email: string, createdAtIso: string): Promise<string> {
  const id = crypto.randomUUID();
  await sql`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
            VALUES (${id}, '', ${email}, 0, ${createdAtIso}, ${createdAtIso})`.execute(db);
  createdUserIds.push(id);
  return id;
}

/** An oidc door; `requireApproval` is the field this sweep reads. */
async function makeDoor(id: string, requireApproval: 0 | 1): Promise<void> {
  await new AuthProvidersRepository(db)
    .create({
      id,
      kind: "oidc",
      name: `Door ${id}`,
      endpointsJson: JSON.stringify({
        authorizationUrl: "https://issuer.invalid/authorize",
        tokenUrl: "https://issuer.invalid/token",
        userInfoUrl: null,
      }),
      entryOrigins: JSON.stringify(["http://localhost:3080"]),
      requireApproval,
    })
    .catch(async () => {
      // A rerun of this file in the same process: the row exists already.
      await new AuthProvidersRepository(db).update(id, { requireApproval });
    });
  createdDoorIds.push(id);
}

/** One `account` row (better-auth's table: physical camelCase, raw SQL). */
async function makeAccount(userId: string, providerId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql`INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt)
            VALUES (${id}, ${providerId}, ${id}, ${providerId}, ${userId}, ${now}, ${now})`.execute(db);
  createdAccountIds.push(id);
  return id;
}

/** A `session` row — only to prove the sweep's defensive half deletes it. */
async function makeSession(userId: string): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql`INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt)
            VALUES (${id}, ${`tok-${id}`}, ${userId}, ${daysAgo(-1)}, ${now}, ${now})`.execute(db);
  createdSessionIds.push(id);
}

/**
 * A `verification` row keyed on the user id in its `identifier` — the table
 * has no userId column, so `identifier` is the only principal handle the
 * sweep's defensive clause can name.
 */
async function makeVerification(userId: string): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
            VALUES (${id}, ${userId}, ${`val-${id}`}, ${daysAgo(-1)}, ${now}, ${now})`.execute(db);
  createdVerificationIds.push(id);
}

/** Force `pending_arrived_at` to a value `setApproval` would never write. */
async function forceClock(userId: string, iso: string | null): Promise<void> {
  await sql`UPDATE user_meta SET pending_arrived_at = ${iso} WHERE user_id = ${userId}`.execute(db);
}

async function userRowExists(id: string): Promise<boolean> {
  const r = await sql`SELECT 1 AS x FROM user WHERE id = ${id}`.execute(db);
  return r.rows.length > 0;
}

async function countIn(table: "account" | "session", userId: string): Promise<number> {
  // Raw SQL: better-auth tables, physical camelCase column (plugin-bypass rule).
  const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.id(table)} WHERE userId = ${userId}`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

async function metaState(
  userId: string,
): Promise<{ approvalState: string | null; pendingArrivedAt: string | null } | undefined> {
  return await db
    .selectFrom("userMeta")
    .select(["approvalState", "pendingArrivedAt"])
    .where("userId", "=", userId)
    .executeTakeFirst();
}

beforeAll(async () => {
  await setupAuthTables();
});

afterAll(async () => {
  for (const id of createdSessionIds) await sql`DELETE FROM session WHERE id = ${id}`.execute(db);
  for (const id of createdVerificationIds) await sql`DELETE FROM verification WHERE id = ${id}`.execute(db);
  for (const id of createdAccountIds) await sql`DELETE FROM account WHERE id = ${id}`.execute(db);
  for (const doorId of createdDoorIds) await new AuthProvidersRepository(db).remove(doorId);
  for (const userId of createdUserIds) {
    await sql`DELETE FROM user_meta WHERE user_id = ${userId}`.execute(db);
    await sql`DELETE FROM user WHERE id = ${userId}`.execute(db);
  }
  await new SettingsRepository(db).delete(PENDING_APPROVAL_EXPIRY_KEY);
});

describe("expiryDays", () => {
  test("absent row reads the 30-day default; a stored number is honored", async () => {
    await new SettingsRepository(db).delete(PENDING_APPROVAL_EXPIRY_KEY);
    expect(await expiryDays(db)).toBe(30);
    await new SettingsRepository(db).set(PENDING_APPROVAL_EXPIRY_KEY, 7);
    expect(await expiryDays(db)).toBe(7);
    await new SettingsRepository(db).set(PENDING_APPROVAL_EXPIRY_KEY, 0);
    expect(await expiryDays(db)).toBe(0);
    await new SettingsRepository(db).delete(PENDING_APPROVAL_EXPIRY_KEY);
  });

  test("a corrupt row falls back to 30 rather than expiring everything or nothing", async () => {
    for (const bad of ["eleven", -5, 2.5, null, true]) {
      await new SettingsRepository(db).set(PENDING_APPROVAL_EXPIRY_KEY, bad);
      expect(await expiryDays(db)).toBe(30);
    }
    await new SettingsRepository(db).delete(PENDING_APPROVAL_EXPIRY_KEY);
  });
});

describe("expirePendingApprovals", () => {
  test("deletes the expired pending arrival from every table and leaves every survivor by id", async () => {
    await new SettingsRepository(db).delete(PENDING_APPROVAL_EXPIRY_KEY); // ⇒ 30 days
    const doorId = `expiry-door-${crypto.randomUUID().slice(0, 8)}`;
    await makeDoor(doorId, 1);
    const staleClock = daysAgo(31); // one stamp: two daysAgo calls differ by ms

    // The victim: pending 31 days ago, with the defensive rows a pending
    // person "never has" — the sweep must not depend on that being true.
    const oldPending = await makeUser(`expiry-old-${crypto.randomUUID().slice(0, 8)}@example.test`, staleClock);
    await makeAccount(oldPending, doorId);
    await new UserMetaRepository(db).setApproval(oldPending, "pending", { arrivedAt: staleClock });
    await makeSession(oldPending);
    await makeVerification(oldPending);

    // The survivors, each a different reason a row must still exist after.
    const freshPending = await makeUser(`expiry-fresh-${crypto.randomUUID().slice(0, 8)}@example.test`, daysAgo(1));
    await makeAccount(freshPending, doorId);
    await new UserMetaRepository(db).setApproval(freshPending, "pending", { arrivedAt: daysAgo(1) });

    const rejectedAncient = await makeUser(`expiry-rej-${crypto.randomUUID().slice(0, 8)}@example.test`, daysAgo(60));
    await makeAccount(rejectedAncient, doorId);
    await new UserMetaRepository(db).setApproval(rejectedAncient, "rejected");
    await forceClock(rejectedAncient, staleClock); // §6: rejected NEVER expires, even with a stale clock

    const pendingNoClock = await makeUser(
      `expiry-noclock-${crypto.randomUUID().slice(0, 8)}@example.test`,
      daysAgo(40),
    );
    await makeAccount(pendingNoClock, doorId);
    await new UserMetaRepository(db).setApproval(pendingNoClock, "pending");
    await forceClock(pendingNoClock, null); // no arrival clock ⇒ nothing to age out

    const approvedAncient = await makeUser(
      `expiry-member-${crypto.randomUUID().slice(0, 8)}@example.test`,
      daysAgo(90),
    );
    await makeAccount(approvedAncient, doorId);
    await new UserMetaRepository(db).setApproval(approvedAncient, "approved");

    const deleted = await expirePendingApprovals(db);
    expect(deleted).toBeGreaterThanOrEqual(1);

    // The victim is gone from every table.
    expect(await userRowExists(oldPending)).toBe(false);
    expect(await countIn("account", oldPending)).toBe(0);
    expect(await countIn("session", oldPending)).toBe(0);
    const v = await sql`SELECT 1 AS x FROM verification WHERE identifier = ${oldPending}`.execute(db);
    expect(v.rows.length).toBe(0);
    expect(await metaState(oldPending)).toBeUndefined();

    // Every survivor is still there BY ID, in the state that saved it.
    expect(await userRowExists(freshPending)).toBe(true);
    expect((await metaState(freshPending))?.approvalState).toBe("pending");
    expect((await metaState(freshPending))?.pendingArrivedAt).not.toBeNull();

    expect(await userRowExists(rejectedAncient)).toBe(true);
    expect((await metaState(rejectedAncient))?.approvalState).toBe("rejected");
    expect((await metaState(rejectedAncient))?.pendingArrivedAt).toBe(staleClock);

    expect(await userRowExists(pendingNoClock)).toBe(true);
    expect((await metaState(pendingNoClock))?.approvalState).toBe("pending");
    expect((await metaState(pendingNoClock))?.pendingArrivedAt).toBeNull();

    expect(await userRowExists(approvedAncient)).toBe(true);
    expect((await metaState(approvedAncient))?.approvalState).toBe("approved");
  });

  test("expiryDays 0 keeps even an expired pending row forever", async () => {
    const doorId = `expiry-forever-door-${crypto.randomUUID().slice(0, 8)}`;
    await makeDoor(doorId, 1);
    const userId = await makeUser(`expiry-forever-${crypto.randomUUID().slice(0, 8)}@example.test`, daysAgo(400));
    await makeAccount(userId, doorId);
    await new UserMetaRepository(db).setApproval(userId, "pending", { arrivedAt: daysAgo(400) });

    await new SettingsRepository(db).set(PENDING_APPROVAL_EXPIRY_KEY, 0);
    try {
      expect(await expirePendingApprovals(db)).toBe(0);
    } finally {
      await new SettingsRepository(db).delete(PENDING_APPROVAL_EXPIRY_KEY);
    }
    expect(await userRowExists(userId)).toBe(true);
    expect((await metaState(userId))?.approvalState).toBe("pending");
  });
});

describe("remarkUnmarkedArrivals", () => {
  test("a fresh one-account arrival sitting approved is re-queued, demoted if auto-promoted", async () => {
    const doorId = `remark-door-${crypto.randomUUID().slice(0, 8)}`;
    await makeDoor(doorId, 1);

    // (a) The measured failure shape: `user.create.after` promoted the
    // first arrival and wrote its meta row (approval_state defaults
    // 'approved'), then `account.create.after` threw before marking.
    const promotedArrival = await makeUser(
      `remark-promoted-${crypto.randomUUID().slice(0, 8)}@example.test`,
      new Date().toISOString(),
    );
    await makeAccount(promotedArrival, doorId);
    await db.insertInto("userMeta").values({ userId: promotedArrival, role: "admin", setupStep: "network" }).execute();

    // The harsher shape: BOTH hooks missed, so there is no meta row at all —
    // "absent reads approved" must catch it too.
    const metalessArrival = await makeUser(
      `remark-metaless-${crypto.randomUUID().slice(0, 8)}@example.test`,
      new Date().toISOString(),
    );
    await makeAccount(metalessArrival, doorId);

    const remarked = await remarkUnmarkedArrivals(db);
    expect(remarked).toBeGreaterThanOrEqual(2);

    const promoted = await metaState(promotedArrival);
    expect(promoted?.approvalState).toBe("pending");
    expect(promoted?.pendingArrivedAt).not.toBeNull();
    const meta = await db
      .selectFrom("userMeta")
      .select(["role", "setupStep"])
      .where("userId", "=", promotedArrival)
      .executeTakeFirstOrThrow();
    expect(meta.role).toBe("user");
    expect(meta.setupStep).toBeNull();

    const metaless = await metaState(metalessArrival);
    expect(metaless?.approvalState).toBe("pending");
    expect(
      (await db.selectFrom("userMeta").select("role").where("userId", "=", metalessArrival).executeTakeFirstOrThrow())
        .role,
    ).toBe("user");
  });

  test("established members, linked users, open doors and rejected rows are never touched", async () => {
    const approvalDoor = `remark-gated-door-${crypto.randomUUID().slice(0, 8)}`;
    await makeDoor(approvalDoor, 1);
    const openDoor = `remark-open-door-${crypto.randomUUID().slice(0, 8)}`;
    await makeDoor(openDoor, 0);

    // An OLD approved member whose door gained require_approval at some
    // point: turning the flag on later must not un-approve established
    // membership. Outside the 2 h window, so the rule alone protects it —
    // and its explicit 'approved' row is the state the rule must respect.
    const oldMember = await makeUser(`remark-old-${crypto.randomUUID().slice(0, 8)}@example.test`, daysAgo(3));
    await makeAccount(oldMember, approvalDoor);
    await new UserMetaRepository(db).setApproval(oldMember, "approved");

    // A fresh user who LINKED the approval door beside their credential
    // account — two accounts means not an arrival (the hook's own skip).
    const linked = await makeUser(
      `remark-linked-${crypto.randomUUID().slice(0, 8)}@example.test`,
      new Date().toISOString(),
    );
    await makeAccount(linked, "credential");
    await makeAccount(linked, approvalDoor);
    await new UserMetaRepository(db).setApproval(linked, "approved");

    // A fresh single-account arrival through a door that asks nothing.
    const openDoorUser = await makeUser(
      `remark-open-${crypto.randomUUID().slice(0, 8)}@example.test`,
      new Date().toISOString(),
    );
    await makeAccount(openDoorUser, openDoor);
    await new UserMetaRepository(db).setApproval(openDoorUser, "approved");

    // A fresh REJECTED row: rejection is terminal until an admin acts; a
    // re-mark pass must not pull it back into the queue.
    const rejected = await makeUser(
      `remark-rejected-${crypto.randomUUID().slice(0, 8)}@example.test`,
      new Date().toISOString(),
    );
    await makeAccount(rejected, approvalDoor);
    await new UserMetaRepository(db).setApproval(rejected, "rejected");

    await remarkUnmarkedArrivals(db);

    for (const id of [oldMember, linked, openDoorUser]) {
      const state = await metaState(id);
      expect(state?.approvalState).toBe("approved");
      expect(state?.pendingArrivedAt).toBeNull();
    }
    expect((await metaState(rejected))?.approvalState).toBe("rejected");
  });
});
