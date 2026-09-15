import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as nodeMaintenanceMigration from "@/db/migrations/0031-node-maintenance.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  nodes: Record<string, unknown>;
}

/**
 * The maintenance columns (spec 2026-09-14 §2).
 *
 * The default is the whole upgrade story and the only thing here that could
 * take a fleet down: a node enrolled before this migration must keep
 * launching, so `maintenance` reads 0 for every row that predates the column
 * and for every row written by a caller that does not mention it.
 */
describe("migration 0031-node-maintenance", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Insert a node row the way the pre-0031 repository did — no maintenance fields at all. */
  const legacyNode = (id: string) =>
    db
      .insertInto("nodes")
      .values({
        id,
        owner_user_id: "u1",
        name: id,
        kind: "agent",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      })
      .execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0031-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    // Written BEFORE the columns exist — the upgrade case this test is about.
    await legacyNode("pre-existing");
    await nodeMaintenanceMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds the three columns", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("maintenance");
    expect(names).toContain("maintenance_at");
    expect(names).toContain("maintenance_source");
  });

  it("leaves every pre-existing node launching", async () => {
    const r = await sql<{
      maintenance: number;
      maintenance_at: string | null;
      maintenance_source: string | null;
    }>`SELECT maintenance, maintenance_at, maintenance_source FROM nodes WHERE id = 'pre-existing'`.execute(db);
    expect(r.rows[0]).toEqual({ maintenance: 0, maintenance_at: null, maintenance_source: null });
  });

  it("defaults a row written without the columns to 0 (the repository's mirror is the same value)", async () => {
    await legacyNode("fresh");
    const r = await sql<{ maintenance: number }>`SELECT maintenance FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0].maintenance).toBe(0);
  });

  it("stores a window: the flag, the stamp that reconciles it, and which end wrote it", async () => {
    await db
      .updateTable("nodes")
      .set({ maintenance: 1, maintenance_at: "2026-09-14T10:00:00.000Z", maintenance_source: "node" })
      .where("id", "=", "fresh")
      .execute();
    const r = await sql<{
      maintenance: number;
      maintenance_at: string;
      maintenance_source: string;
    }>`SELECT maintenance, maintenance_at, maintenance_source FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0]).toEqual({
      maintenance: 1,
      maintenance_at: "2026-09-14T10:00:00.000Z",
      maintenance_source: "node",
    });
  });

  it("down removes all three and leaves the rows", async () => {
    await nodeMaintenanceMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("maintenance");
    expect(names).not.toContain("maintenance_at");
    expect(names).not.toContain("maintenance_source");
    const left = await sql<{ id: string }>`SELECT id FROM nodes ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["fresh", "pre-existing"]);

    await nodeMaintenanceMigration.up(db); // leave the DB on the current shape
  });
});
