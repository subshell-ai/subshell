import { beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";

/**
 * The wizard's per-user bookmark (spec 2026-09-16).
 *
 * It is a bookmark, not a gate — nothing about what a person may do depends
 * on it — which is exactly why the unknown-value case below matters: a row
 * hand-edited to a step this build does not know must read as "no bookmark"
 * rather than become a redirect target nothing can satisfy.
 */
const repo = new UserMetaRepository(db);

describe("UserMetaRepository setup-step bookmark", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("reads null for a user with no user_meta row at all", async () => {
    expect(await repo.getSetupStep(`u-absent-${crypto.randomUUID()}`)).toBeNull();
  });

  it("round-trips every step in the enum", async () => {
    const user = `u-step-${crypto.randomUUID()}`;
    for (const step of ["network", "agent", "launch"] as const) {
      await repo.setSetupStep(user, step);
      expect(await repo.getSetupStep(user)).toBe(step);
    }
  });

  it("clears the bookmark when told null", async () => {
    const user = `u-clear-${crypto.randomUUID()}`;
    await repo.setSetupStep(user, "launch");
    await repo.setSetupStep(user, null);
    expect(await repo.getSetupStep(user)).toBeNull();
  });

  it("upserts for a user whose row was never created, and keeps their role", async () => {
    // Same reason `setNotifyEnabled` upserts: a user minted before this
    // column existed has a row to update, but a user_meta row can also be
    // missing entirely — and writing one must not silently make somebody an
    // admin or demote one.
    const user = `u-upsert-${crypto.randomUUID()}`;
    await db.insertInto("userMeta").values({ userId: user, role: "admin" }).execute();
    await repo.setSetupStep(user, "agent");
    expect(await repo.getRole(user)).toBe("admin");
    expect(await repo.getSetupStep(user)).toBe("agent");
  });

  it("reads a stored value outside the enum as null (fail safe)", async () => {
    // Nothing acts on this but a redirect, so an unrecognised string must
    // read as "no bookmark" — not as a step the wizard cannot render.
    const user = `u-bogus-${crypto.randomUUID()}`;
    await repo.setSetupStep(user, "network");
    await sql`UPDATE user_meta SET setup_step = 'atlantis' WHERE user_id = ${user}`.execute(db);
    expect(await repo.getSetupStep(user)).toBeNull();
  });
});
