import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { setupAuthTables } from "../../api/__tests__/helpers/auth-tables.js";
import { applyLockdown, LOCKDOWN_KEY, lockdownEnabled } from "../lockdown.js";

/**
 * The `expectFrom` discipline (code review 2026-09-24, finding I1): the
 * confirm gate and the flip ACT used to read the flag separately, so a second
 * admin's no-op echo — legitimately confirm-free, because it asked for the
 * state it already saw — could land between its read and the ACT, and the
 * other admin's real flip would then execute against a world that had moved:
 * an emergency lockdown lifted with nothing typed, or the seconds-long stop
 * loop run twice over the same rows. The route now hands its gate-read down,
 * and this service refuses to act when the world has moved since.
 */

describe("applyLockdown's expectFrom", () => {
  const actorEmail = `lockdown-unit-${crypto.randomUUID()}@subshell.local`;
  let actorId = "";

  async function auditRows(): Promise<{ metadataJson: string | null }[]> {
    return db
      .selectFrom("auditEvents")
      .select("metadataJson")
      .where("actorUserId", "=", actorId)
      .where("action", "=", "settings.update")
      .where("targetId", "=", LOCKDOWN_KEY)
      .execute();
  }

  beforeAll(async () => {
    await setupAuthTables();
    actorId = await new UsersRepository(db).createUser({
      email: actorEmail,
      name: actorEmail,
      passwordHash: await hashPassword("lockdown-unit-pass-1"),
      role: "admin",
    });
  });

  afterAll(async () => {
    await db.deleteFrom("settings").where("key", "=", LOCKDOWN_KEY).execute();
    await db
      .deleteFrom("auditEvents")
      .where("actorUserId", "=", actorId)
      .where("action", "=", "settings.update")
      .where("targetId", "=", LOCKDOWN_KEY)
      .execute();
  });

  it("acts when the world still matches the gate-read, and audits", async () => {
    await db.deleteFrom("settings").where("key", "=", LOCKDOWN_KEY).execute();
    const effects = await applyLockdown(db, { on: true, expectFrom: false, actorUserId: actorId });
    expect(effects.before).toBe(false);
    expect(await lockdownEnabled(db)).toBe(true);
    const rows = await auditRows();
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]?.metadataJson ?? "{}")).toMatchObject({ from: false, to: true });
    await db.deleteFrom("settings").where("key", "=", LOCKDOWN_KEY).execute();
    await db
      .deleteFrom("auditEvents")
      .where("actorUserId", "=", actorId)
      .where("action", "=", "settings.update")
      .where("targetId", "=", LOCKDOWN_KEY)
      .execute();
  });

  it("does nothing when the state moved before this call: no write, no loop, no audit", async () => {
    // The race as observed: the gate read OFF, then another admin's ON lands.
    // This call asked for ON too — the world already has it, so the correct
    // act is NONE: no second kill loop, no duplicate `{from:false,to:true}`.
    await new SettingsRepository(db).set(LOCKDOWN_KEY, true);
    const effects = await applyLockdown(db, { on: true, expectFrom: false, actorUserId: actorId });
    expect(effects.before).toBe(true);
    expect(effects.stopped).toEqual([]);
    expect(await auditRows()).toEqual([]);
    // And the way OUT read as OFF while it is already OFF: same shape.
    const off = await applyLockdown(db, { on: false, expectFrom: false, actorUserId: actorId });
    expect(off.before).toBe(true);
    expect(off.stopped).toEqual([]);
    expect(await lockdownEnabled(db)).toBe(true); // the row still says ON
    expect(await auditRows()).toEqual([]);
    await db.deleteFrom("settings").where("key", "=", LOCKDOWN_KEY).execute();
  });
});
