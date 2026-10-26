import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as sshLaunchMigration from "@/db/migrations/0048-ssh-launch-and-saved-hosts.js";
import * as sshPresetsMigration from "@/db/migrations/0054-ssh-presets.js";
import * as presetEnabledMigration from "@/db/migrations/0068-preset-enabled.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Preset enable/disable (spec 2026-10-24): both preset tables gain an
 * `enabled` integer, NOT NULL DEFAULT 1 — 1 = offered, 0 = hidden from
 * pickers and refused at launch. It is a local preference, never a portable
 * preset property, so an imported preset always starts enabled.
 *
 * The DB is built from the migration prefix that produces the two tables the
 * flag lands on: profiles → presets (0027) and the SSH preset table (0054),
 * which needs the saved-hosts table 0048 created first. A re-run of `up` is a
 * no-op (guarded on the column), and `down` removes the column again.
 */
describe("migration 0068-preset-enabled", () => {
  let dbFile: string;
  let db: Kysely<any>;

  async function hasColumn(target: Kysely<any>, table: string, column: string): Promise<boolean> {
    const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}`.execute(
      target,
    );
    return r.rows.length > 0;
  }

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0068-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    await subshellRenameMigration.up(db);
    await presetsMigration.up(db);
    await sshLaunchMigration.up(db);
    await sshPresetsMigration.up(db);
    // better-auth owns the `user` table, so no app migration creates it, but
    // ssh_presets.user_id references it and the pragmas-enforced FK check
    // needs the row the test inserts (the 0054 test's stand-in precedent).
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO user VALUES ('u1')`.execute(db);
  });

  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  it("up adds enabled to both preset tables, defaulting to 1", async () => {
    // Precondition: neither table carries the flag yet.
    expect(await hasColumn(db, "presets", "enabled")).toBe(false);
    expect(await hasColumn(db, "ssh_presets", "enabled")).toBe(false);

    await presetEnabledMigration.up(db);

    expect(await hasColumn(db, "presets", "enabled")).toBe(true);
    expect(await hasColumn(db, "ssh_presets", "enabled")).toBe(true);

    // An insert that does not say, says ON — the DB default is the contract.
    await db
      .insertInto("presets")
      .values({
        id: "p1",
        user_id: "u1",
        harness_id: "claude-code",
        name: "default-on",
        config_isolation: 0,
        restart_on_exit: 0,
        created_at: "now",
        updated_at: "now",
      })
      .execute();
    const preset = await db.selectFrom("presets").select("enabled").where("id", "=", "p1").executeTakeFirstOrThrow();
    expect(preset.enabled).toBe(1);

    await db
      .insertInto("ssh_presets")
      .values({
        id: "s1",
        user_id: "u1",
        name: "ssh-default-on",
        destination: "host:22",
        authentication: "connecting",
        created_at: "now",
        updated_at: "now",
      })
      .execute();
    const ssh = await db.selectFrom("ssh_presets").select("enabled").where("id", "=", "s1").executeTakeFirstOrThrow();
    expect(ssh.enabled).toBe(1);
  });

  it("up twice is a no-op", async () => {
    await presetEnabledMigration.up(db);
    expect(await hasColumn(db, "presets", "enabled")).toBe(true);
    expect(await hasColumn(db, "ssh_presets", "enabled")).toBe(true);
  });

  it("up and down skip a table the partial schema does not have", async () => {
    // The curated `:memory:` suites hand-build partial schemas, so `up` may
    // be called on a database holding `presets` but no `ssh_presets`.
    // pragma_table_info answers a missing table with zero rows, which a
    // column-only guard reads as "absent" — the addColumn then throws
    // "no such table". The table guard must make the absent table a skip.
    const partial = new Kysely<any>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(":memory:") }) });
    try {
      await sql`CREATE TABLE presets (id TEXT PRIMARY KEY)`.execute(partial);

      await presetEnabledMigration.up(partial);
      expect(await hasColumn(partial, "presets", "enabled")).toBe(true);

      await presetEnabledMigration.down(partial);
      expect(await hasColumn(partial, "presets", "enabled")).toBe(false);
    } finally {
      await partial.destroy();
    }
  });

  it("down drops the column from both tables, and up re-applies", async () => {
    await presetEnabledMigration.down(db);
    expect(await hasColumn(db, "presets", "enabled")).toBe(false);
    expect(await hasColumn(db, "ssh_presets", "enabled")).toBe(false);

    await presetEnabledMigration.up(db);
    expect(await hasColumn(db, "presets", "enabled")).toBe(true);
    expect(await hasColumn(db, "ssh_presets", "enabled")).toBe(true);
  });
});
