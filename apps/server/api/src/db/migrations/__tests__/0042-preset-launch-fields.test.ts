import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * The launch columns (spec 2026-09-29 preset-launch-fields) and, load-bearing,
 * the node_id FK: deleting the NODE unsets the preset's hint (SET NULL) rather
 * than taking the row with it. A preset is saved customisation; the node dying
 * only means it can no longer be cross-comm ready. This needs the AUTH tables
 * too (not just `runMigrations`): the FK to `user` is only enforced once that
 * table exists, and the SET NULL being tested rides the same enforcement.
 */
describe("migration 0042 preset launch fields", () => {
  const repo = new PresetsRepository(db);
  const email = `m0042-${crypto.randomUUID()}@subshell.local`;
  let userId = "";
  const nodeId = `n-0042-${crypto.randomUUID()}`;
  const createdPresetIds: string[] = [];

  async function mkPreset(name: string, over?: Partial<{ nodeId: string | null }>): Promise<string> {
    const id = crypto.randomUUID();
    createdPresetIds.push(id);
    await repo.create({
      id,
      userId,
      harnessId: "claude-code",
      name,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
      ...over,
    });
    return id;
  }

  beforeAll(async () => {
    await ensureMigratedTestDb();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword("m0042-pass"),
      role: "user",
    });
    // The round-trip test names this node, and FK enforcement (ON once the
    // auth tables exist) demands a real parent at INSERT time - SET NULL is the
    // DELETE-side rule the third test proves, not permission to invent ids.
    await new NodesRepository(db).create({ id: nodeId, ownerUserId: userId, name: "box", kind: "agent" });
  });

  afterAll(async () => {
    for (const id of createdPresetIds) await repo.delete(id);
    await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
    await deleteUserByEmailOrId(email);
  });

  it("the three columns exist and default to null", async () => {
    const row = await repo.findById(await mkPreset("p-nulls"));
    expect(row?.nodeId).toBeNull();
    expect(row?.workingDir).toBeNull();
    expect(row?.promptBlocks).toBeNull();
  });

  it("they round-trip a full cross-comm-ready row", async () => {
    const id = crypto.randomUUID();
    createdPresetIds.push(id);
    await repo.create({
      id,
      userId,
      harnessId: "claude-code",
      name: "p-full",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      restartOnExit: 0,
      nodeId,
      workingDir: "/srv/app",
      promptBlocks: JSON.stringify([{ kind: "custom", description: "", body: "go" }]),
    });
    const row = await repo.findById(id);
    expect(row?.nodeId).toBe(nodeId);
    expect(row?.workingDir).toBe("/srv/app");
    expect(JSON.parse(row?.promptBlocks ?? "[]")).toEqual([{ kind: "custom", description: "", body: "go" }]);
  });

  it("deleting the referenced node nulls the hint and keeps the row", async () => {
    // The node already exists (beforeAll created it for the round-trip test);
    // this deletes it out from under a preset that names it.
    const id = await mkPreset("p-fk", { nodeId });
    await repo.update(id, {
      workingDir: "/srv/app",
      promptBlocks: JSON.stringify([{ kind: "custom", description: "", body: "go" }]),
    });

    await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
    const row = await repo.findById(id);
    expect(row).toBeDefined();
    expect(row?.nodeId).toBeNull();
    // The other launch fields survive the node's death; the row keeps its dir/prompt.
    expect(row?.workingDir).toBe("/srv/app");
    expect(row?.promptBlocks).toContain('"body":"go"');
  });
});
