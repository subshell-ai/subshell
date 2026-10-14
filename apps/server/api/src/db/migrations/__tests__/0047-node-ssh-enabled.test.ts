import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as sshEnabledMigration from "@/db/migrations/0047-node-ssh-enabled.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  nodes: Record<string, unknown>;
}

/**
 * The SSH capability gate columns. Default 0 is the whole upgrade story: a
 * node enrolled before this migration (and the seeded local row) reads OFF,
 * because SSH egress and key use are opt-in per machine.
 */
describe("migration 0047-node-ssh-enabled", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Insert a node row the way the pre-0047 repository did - no ssh fields at all. */
  const legacyNode = (id: string) =>
    db
      .insertInto("nodes")
      .values({
        id,
        owner_user_id: "u1",
        name: id,
        kind: "agent",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      })
      .execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0047-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    // Written BEFORE the columns exist - the upgrade case this test is about.
    await legacyNode("pre-existing");
    await sshEnabledMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds the two columns", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("ssh_enabled");
    expect(names).toContain("ssh_enabled_at");
  });

  it("leaves every pre-existing node with SSH off (default-off doctrine)", async () => {
    const r = await sql<{
      ssh_enabled: number;
      ssh_enabled_at: string | null;
    }>`SELECT ssh_enabled, ssh_enabled_at FROM nodes WHERE id = 'pre-existing'`.execute(db);
    expect(r.rows[0]).toEqual({ ssh_enabled: 0, ssh_enabled_at: null });
  });

  it("defaults a row written without the columns to 0", async () => {
    await legacyNode("fresh");
    const r = await sql<{ ssh_enabled: number }>`SELECT ssh_enabled FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0].ssh_enabled).toBe(0);
  });

  it("stores the flag with its stamp", async () => {
    await db
      .updateTable("nodes")
      .set({ ssh_enabled: 1, ssh_enabled_at: "2026-10-07T10:00:00.000Z" })
      .where("id", "=", "fresh")
      .execute();
    const r = await sql<{
      ssh_enabled: number;
      ssh_enabled_at: string;
    }>`SELECT ssh_enabled, ssh_enabled_at FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0]).toEqual({ ssh_enabled: 1, ssh_enabled_at: "2026-10-07T10:00:00.000Z" });
  });

  it("down removes both columns and leaves the rows", async () => {
    await sshEnabledMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("ssh_enabled");
    expect(names).not.toContain("ssh_enabled_at");
    const left = await sql<{ id: string }>`SELECT id FROM nodes ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["fresh", "pre-existing"]);
    await sshEnabledMigration.up(db); // leave the DB on the current shape
  });
});
