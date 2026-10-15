import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as sshEnabledMigration from "@/db/migrations/0047-node-ssh-enabled.js";
import * as wideForwardsMigration from "@/db/migrations/0055-node-ssh-wide-forwards.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  nodes: Record<string, unknown>;
}

/**
 * The wide-bind allowance column (spec 2026-10-15 §6). Default 0 is the
 * upgrade story: every machine, the control-plane host included, stays
 * loopback-only until its owner widens it.
 */
describe("migration 0055-node-ssh-wide-forwards", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0055-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    await sshEnabledMigration.up(db);
    // Written BEFORE the column exists - the upgrade case this test is about.
    await db
      .insertInto("nodes")
      .values({
        id: "pre-existing",
        owner_user_id: "u1",
        name: "pre-existing",
        kind: "agent",
        created_at: "2026-10-15T00:00:00.000Z",
        updated_at: "2026-10-15T00:00:00.000Z",
      })
      .execute();
    await wideForwardsMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds the column", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain("ssh_wide_forwards");
  });

  it("rows written before the migration read 0 (loopback stays the floor after an upgrade)", async () => {
    const row = await db
      .selectFrom("nodes")
      .select("ssh_wide_forwards")
      .where("id", "=", "pre-existing")
      .executeTakeFirst();
    expect(row?.ssh_wide_forwards).toBe(0);
  });

  it("down removes the column", async () => {
    await wideForwardsMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    expect(cols.rows.map((c) => c.name)).not.toContain("ssh_wide_forwards");
  });
});
