import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as presetNameUniqueMigration from "@/db/migrations/0028-preset-name-unique.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  presets: Record<string, unknown>;
  profiles: Record<string, unknown>;
}

/**
 * The preset name becomes unique per (user, harness), case-insensitively.
 *
 * The fixture is the shape `0001-init.ts` allowed while documenting the
 * opposite: one user holding several same-named presets for one harness,
 * including a case-only pair and a name whose obvious suffix is already
 * taken. The migration must rename rather than delete (a preset is saved
 * work), must keep the OLDEST row's name, and must leave a database the
 * unique index actually applies to.
 */
describe("migration 0028-preset-name-unique", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  const preset = (id: string, name: string, createdAt: string, harnessId = "claude-code", userId = "u1") =>
    db
      .insertInto("presets")
      .values({
        id,
        user_id: userId,
        harness_id: harnessId,
        name,
        description: null,
        env_json: null,
        flags_json: null,
        settings_json: null,
        config_isolation: 0,
        restart_on_exit: 0,
        created_at: createdAt,
      })
      .execute();

  const nameOf = async (id: string): Promise<string> =>
    (await sql<{ name: string }>`SELECT name FROM presets WHERE id = ${id}`.execute(db)).rows[0].name;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0028-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    await subshellRenameMigration.up(db);
    await presetsMigration.up(db);

    // Oldest keeps "Dev"; the case-only twin and the later exact twin move.
    await preset("d1", "Dev", "2026-09-01T00:00:00.000Z");
    await preset("d2", "DEV", "2026-09-02T00:00:00.000Z");
    await preset("d3", "Dev", "2026-09-03T00:00:00.000Z");
    // The suffix this group WANTS is already a real name someone typed, so
    // the loop has to keep looking rather than assume "(2)" is free.
    await preset("t1", "Test", "2026-09-01T00:00:00.000Z");
    await preset("t2", "Test", "2026-09-02T00:00:00.000Z");
    await preset("t3", "Test (2)", "2026-09-03T00:00:00.000Z");
    // Same name, DIFFERENT harness and DIFFERENT user — neither collides.
    await preset("o1", "Dev", "2026-09-01T00:00:00.000Z", "codex");
    await preset("o2", "Dev", "2026-09-01T00:00:00.000Z", "claude-code", "u2");

    await presetNameUniqueMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("keeps the oldest row's name and renames the rest, case-insensitively", async () => {
    expect(await nameOf("d1")).toBe("Dev");
    // "DEV" collides even though no byte-equal name exists: the index is
    // NOCASE because both surfaces that address a preset by name fold case.
    // It keeps its OWN spelling through the rename — the migration suffixes
    // the row it is moving, it does not restyle it to the winner's case. A
    // user who typed capitals gets to keep them.
    expect(await nameOf("d2")).toBe("DEV (2)");
    expect(await nameOf("d3")).toBe("Dev (3)");
  });

  it("skips a suffix a real name already occupies", async () => {
    expect(await nameOf("t1")).toBe("Test");
    expect(await nameOf("t2")).toBe("Test (3)"); // (2) was taken by t3
    expect(await nameOf("t3")).toBe("Test (2)"); // untouched — it never collided
  });

  it("scopes the collision to one user and one harness", async () => {
    expect(await nameOf("o1")).toBe("Dev");
    expect(await nameOf("o2")).toBe("Dev");
  });

  it("renames — it never deletes a user's saved work", async () => {
    const n = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM presets`.execute(db);
    expect(n.rows[0].n).toBe(8);
  });

  it("leaves an index that actually refuses the next duplicate", async () => {
    await expect(preset("d4", "dEv", "2026-09-04T00:00:00.000Z")).rejects.toThrow(/UNIQUE/);
    // …and still accepts the same name on another harness.
    await preset("d5", "Dev", "2026-09-04T00:00:00.000Z", "hermes");
    expect(await nameOf("d5")).toBe("Dev");
  });

  it("replaces the prefix index rather than keeping both", async () => {
    const r = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_presets%'
    `.execute(db);
    expect(r.rows.map((i) => i.name).sort()).toEqual(["idx_presets_user_harness_name"]);
  });

  it("down restores the non-unique lookup index and keeps the renames", async () => {
    await presetNameUniqueMigration.down(db);
    const r = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_presets%'
    `.execute(db);
    expect(r.rows.map((i) => i.name).sort()).toEqual(["idx_presets_user_harness"]);
    // A downgrade returns the schema, not the data: "DEV (2)" is a real name
    // by now, and nothing recorded what it used to be.
    expect(await nameOf("d2")).toBe("DEV (2)");
    // The refusal is gone with the index.
    await preset("d6", "Dev", "2026-09-05T00:00:00.000Z");
    expect(await nameOf("d6")).toBe("Dev");
    await presetNameUniqueMigration.up(db); // leave the DB on the current shape
  });
});
