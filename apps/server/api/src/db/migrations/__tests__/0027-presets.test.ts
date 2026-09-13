import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  presets: Record<string, unknown>;
  profiles: Record<string, unknown>;
  subshells: Record<string, unknown>;
}

/**
 * Profiles become presets (spec 2026-09-13 §6): the table renames, the pin
 * and the Default flag drop, and `subshells.profile_id` (NOT NULL) becomes
 * `subshells.preset_id` (NULLABLE) with the values copied — never a table
 * rebuild, because workspace_panes/subshell_shares FKs cascade on it.
 *
 * The DB is hand-built from the migration prefix that produced the OLD shape
 * (0001 profiles+sessions, 0003 restart_on_exit, 0010 is_default, 0017
 * profiles.node_id, 0019 sessions→subshells), with raw snake_case fixtures
 * that hold the purge's whole distinction: a seeded Default (is_default = 1,
 * pinned to a node, referenced by one subshell — purged, its subshell freed)
 * and a USER preset literally NAMED "Default" (is_default = 0, referenced by
 * another — survives with its subshell's reference intact).
 */
describe("migration 0027-presets", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  async function columnNames(table: string): Promise<string[]> {
    const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
    return r.rows.map((c) => c.name);
  }

  async function presetIndexNames(): Promise<string[]> {
    const r = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_presets%' OR name LIKE 'idx_profiles%')
    `.execute(db);
    return r.rows.map((i) => i.name).sort();
  }

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0027-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db); // profiles gains node_id; sessions gains node_id
    await subshellRenameMigration.up(db); // sessions → subshells

    // A profile in the seeder's exact Default shape, pinned to a node — the
    // two columns this migration must delete — and the row the purge must
    // delete with them.
    await db
      .insertInto("profiles")
      .values({
        id: "p-default",
        user_id: "u1",
        harness_id: "claude-code",
        name: "Default",
        description: null,
        env_json: null,
        flags_json: null,
        settings_json: null,
        config_isolation: 0,
        is_default: 1,
        node_id: "n1",
        restart_on_exit: 1,
      })
      .execute();
    // A subshell pointing at the seeded Default — the reference the purge
    // must free (preset_id NULL), not leave dangling.
    await db
      .insertInto("subshells")
      .values({
        id: "s1",
        user_id: "u1",
        profile_id: "p-default",
        harness_id: "claude-code",
        name: "first",
        working_dir: "/tmp",
      })
      .execute();
    // The other half of the purge's distinction: a USER-created preset, on
    // another harness, that happens to be NAMED "Default" (is_default = 0 —
    // the flag named the seeder, never the string) with restart_on_exit (the
    // surviving row's data pin), plus its subshell — the value the column
    // copy must carry over and keep.
    await db
      .insertInto("profiles")
      .values({
        id: "p-named",
        user_id: "u1",
        harness_id: "pi",
        name: "Default",
        description: null,
        env_json: null,
        flags_json: null,
        settings_json: null,
        config_isolation: 0,
        is_default: 0,
        node_id: null,
        restart_on_exit: 1,
      })
      .execute();
    await db
      .insertInto("subshells")
      .values({
        id: "s-named",
        user_id: "u1",
        profile_id: "p-named",
        harness_id: "pi",
        name: "named-default",
        working_dir: "/tmp",
      })
      .execute();
  });

  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  it("up renames the table and drops is_default / node_id, keeping restart_on_exit", async () => {
    await presetsMigration.up(db);

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('profiles', 'presets')
    `.execute(db);
    expect(tables.rows.map((t) => t.name)).toEqual(["presets"]);

    const cols = await columnNames("presets");
    expect(cols).not.toContain("is_default");
    expect(cols).not.toContain("node_id");
    expect(cols).toContain("restart_on_exit");
    // The surviving row kept its data.
    const row = await db.selectFrom("presets").selectAll().where("id", "=", "p-named").executeTakeFirstOrThrow();
    expect(row.restart_on_exit).toBe(1);
    expect(row.name).toBe("Default");
  });

  it("up purges the seeded Defaults; a user preset NAMED Default survives", async () => {
    // The purge hunts by FLAG, not by name or harness.
    const purged = await db.selectFrom("presets").select("id").where("id", "=", "p-default").execute();
    expect(purged).toEqual([]);
    // Its subshell is freed, not left dangling at a deleted id.
    const s1 = await db.selectFrom("subshells").select("preset_id").where("id", "=", "s1").executeTakeFirstOrThrow();
    expect(s1.preset_id).toBeNull();
    // The user's own "Default" (is_default = 0, harness pi) is untouched,
    // and its subshell's reference survives the UPDATE that ran first.
    const named = await db.selectFrom("presets").select("id").where("id", "=", "p-named").execute();
    expect(named.length).toBe(1);
    const sNamed = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s-named")
      .executeTakeFirstOrThrow();
    expect(sNamed.preset_id).toBe("p-named");
  });

  it("up turns profile_id into a nullable preset_id, copying values", async () => {
    const cols = await sql<{ name: string; notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info('subshells') WHERE name IN ('profile_id', 'preset_id')
    `.execute(db);
    expect(cols.rows.map((c) => c.name)).toEqual(["preset_id"]);
    expect(cols.rows[0]?.notnull).toBe(0);

    // The copy proof rides the SURVIVING row (s1's copy is freed by the
    // purge — the copy ran first; the purge test pins that).
    const row = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s-named")
      .executeTakeFirstOrThrow();
    expect(row.preset_id).toBe("p-named");

    // NULLABLE is the point: an insert omitting preset_id succeeds…
    await db
      .insertInto("subshells")
      .values({ id: "s2", user_id: "u1", harness_id: "pi", name: "no-preset", working_dir: "/tmp" })
      .execute();
    const omitted = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s2")
      .executeTakeFirstOrThrow();
    expect(omitted.preset_id).toBeNull();
    // …and so does an explicit null.
    await db
      .insertInto("subshells")
      .values({
        id: "s3",
        user_id: "u1",
        harness_id: "pi",
        name: "explicit-null",
        working_dir: "/tmp",
        preset_id: null,
      })
      .execute();
    const explicit = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s3")
      .executeTakeFirstOrThrow();
    expect(explicit.preset_id).toBeNull();
  });

  it("up renames the user+harness index (SQLite has no index rename)", async () => {
    expect(await presetIndexNames()).toEqual(["idx_presets_user_harness"]);
  });

  it("up twice is a no-op", async () => {
    const colsBefore = await columnNames("presets");
    const subBefore = await columnNames("subshells");
    const idxBefore = await presetIndexNames();

    await presetsMigration.up(db);

    expect(await columnNames("presets")).toEqual(colsBefore);
    expect(await columnNames("subshells")).toEqual(subBefore);
    expect(await presetIndexNames()).toEqual(idxBefore);
  });

  it("down restores the old shape, and up re-applies (round-trip)", async () => {
    await presetsMigration.down(db);

    // presets → profiles, with the two columns back…
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('profiles', 'presets')
    `.execute(db);
    expect(tables.rows.map((t) => t.name)).toEqual(["profiles"]);
    const cols = await columnNames("profiles");
    expect(cols).toContain("is_default");
    expect(cols).toContain("node_id");
    // …all rows downgraded to deletable (the flag cannot be re-derived)…
    const flagged = await db.selectFrom("profiles").select("id").where("is_default", "=", 1).execute();
    expect(flagged).toEqual([]);
    // …and the index back under its original name.
    expect(await presetIndexNames()).toEqual(["idx_profiles_user_harness"]);

    // subshells.profile_id is back NOT NULL DEFAULT ''; the value survived.
    const subCols = await sql<{ name: string; notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info('subshells') WHERE name = 'profile_id'
    `.execute(db);
    expect(subCols.rows[0]?.notnull).toBe(1);
    // s1 pointed at the purged Default; its NULL has no row to name any
    // more, so it downgrades to '' exactly like the presetless rows (the
    // purge is history — down does not resurrect deleted rows).
    const s1 = await db.selectFrom("subshells").select("profile_id").where("id", "=", "s1").executeTakeFirstOrThrow();
    expect(s1.profile_id).toBe("");
    // The presetless rows document their downgrade as '' (spec: no honest value).
    const s2 = await db.selectFrom("subshells").select("profile_id").where("id", "=", "s2").executeTakeFirstOrThrow();
    expect(s2.profile_id).toBe("");

    // up again lands on the same new schema and re-copies the values. The
    // purge re-RUNS here (down re-added the is_default column) and must
    // delete nothing: every surviving row is a user row with flag 0, and
    // that is the copy proof's subject too — p-named and s-named's reference.
    await presetsMigration.up(db);
    expect(await presetIndexNames()).toEqual(["idx_presets_user_harness"]);
    const survivors = await db.selectFrom("presets").select("id").orderBy("id").execute();
    expect(survivors.map((r) => r.id)).toEqual(["p-named"]);
    const sNamedAgain = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s-named")
      .executeTakeFirstOrThrow();
    expect(sNamedAgain.preset_id).toBe("p-named");
    // s1's downgrade '' re-lands on NULL (the NULLIF copy), nothing more.
    const s1Again = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s1")
      .executeTakeFirstOrThrow();
    expect(s1Again.preset_id).toBeNull();
    // The presetless row's downgrade `''` comes back as NULL — the round-trip
    // is lossless in the direction the schema documents (NULLIF on the copy).
    const s2Again = await db
      .selectFrom("subshells")
      .select("preset_id")
      .where("id", "=", "s2")
      .executeTakeFirstOrThrow();
    expect(s2Again.preset_id).toBeNull();
  });
});
