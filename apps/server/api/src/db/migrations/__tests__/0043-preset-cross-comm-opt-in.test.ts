import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * The cross-subshell comms switch (spec 2026-09-29, migration 0043): a stored
 * opt-in, DEFAULT OFF. Readiness for agents is this column AND the launch
 * trio - the trio alone promises nothing until the operator flips it.
 */
describe("migration 0043 preset cross-comm opt-in", () => {
  const repo = new PresetsRepository(db);
  const email = `m0043-${crypto.randomUUID()}@subshell.local`;
  let userId = "";
  const createdIds: string[] = [];

  beforeAll(async () => {
    await ensureMigratedTestDb();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword("m0043-pass"),
      role: "user",
    });
  });

  afterAll(async () => {
    for (const id of createdIds) await repo.delete(id);
    await deleteUserByEmailOrId(email);
  });

  it("new rows are OFF, and the flag round-trips an update", async () => {
    const id = crypto.randomUUID();
    createdIds.push(id);
    await repo.create({
      id,
      userId,
      harnessId: "claude-code",
      name: "cc-flag",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
    });
    expect((await repo.findById(id))?.crossCommEnabled).toBe(0);
    await repo.update(id, { crossCommEnabled: 1 });
    expect((await repo.findById(id))?.crossCommEnabled).toBe(1);
    await repo.update(id, { crossCommEnabled: 0 });
    expect((await repo.findById(id))?.crossCommEnabled).toBe(0);
  });
});
