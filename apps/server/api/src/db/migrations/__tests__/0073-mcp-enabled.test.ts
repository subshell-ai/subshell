import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as mcpEnabledMigration from "@/db/migrations/0073-mcp-enabled.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  nodes: Record<string, unknown>;
  user_meta: Record<string, unknown>;
}

/**
 * The two MCP-use switch columns. Default 1 INVERTS 0047/0062's doctrine, and
 * that inversion is the whole upgrade story this test guards: MCP wiring
 * already happens on every launch, so an upgrade must leave it on. A DEFAULT 0
 * slipping in would strip cross-agent comms from every existing account and
 * machine on the next boot, and no other suite would notice, because the
 * launch path reads the column with the same default.
 */
describe("migration 0073-mcp-enabled", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Insert a node row the way the pre-0073 repository did - no MCP fields at all. */
  const legacyNode = (id: string) =>
    db
      .insertInto("nodes")
      .values({
        id,
        owner_user_id: "u1",
        name: id,
        kind: "agent",
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      })
      .execute();

  /** A user_meta row written before the column existed. */
  const legacyMeta = (userId: string) => db.insertInto("user_meta").values({ user_id: userId }).execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0073-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    // Written BEFORE the columns exist - the upgrade case this test is about.
    await legacyNode("pre-existing");
    await legacyMeta("u1");
    await mcpEnabledMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds the three columns", async () => {
    const nodeCols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const nodeNames = nodeCols.rows.map((c) => c.name);
    expect(nodeNames).toContain("mcp_enabled");
    expect(nodeNames).toContain("mcp_enabled_at");
    const metaCols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('user_meta')`.execute(db);
    expect(metaCols.rows.map((c) => c.name)).toContain("mcp_enabled");
  });

  it("leaves every pre-existing node and account ENABLED (default-on doctrine)", async () => {
    const r = await sql<{
      mcp_enabled: number;
      mcp_enabled_at: string | null;
    }>`SELECT mcp_enabled, mcp_enabled_at FROM nodes WHERE id = 'pre-existing'`.execute(db);
    expect(r.rows[0]).toEqual({ mcp_enabled: 1, mcp_enabled_at: null });
    const m = await sql<{ mcp_enabled: number }>`SELECT mcp_enabled FROM user_meta WHERE user_id = 'u1'`.execute(db);
    expect(m.rows[0].mcp_enabled).toBe(1);
  });

  it("defaults a row written without the columns to 1", async () => {
    await legacyNode("fresh");
    const r = await sql<{
      mcp_enabled: number;
    }>`SELECT mcp_enabled FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0].mcp_enabled).toBe(1);
  });

  it("stores a refusal with its stamp", async () => {
    await db
      .updateTable("nodes")
      .set({ mcp_enabled: 0, mcp_enabled_at: "2026-11-01T10:00:00.000Z" })
      .where("id", "=", "fresh")
      .execute();
    const r = await sql<{
      mcp_enabled: number;
      mcp_enabled_at: string;
    }>`SELECT mcp_enabled, mcp_enabled_at FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0]).toEqual({ mcp_enabled: 0, mcp_enabled_at: "2026-11-01T10:00:00.000Z" });
  });

  it("down removes all three columns and leaves the rows", async () => {
    await mcpEnabledMigration.down(db);
    const nodeCols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const nodeNames = nodeCols.rows.map((c) => c.name);
    expect(nodeNames).not.toContain("mcp_enabled");
    expect(nodeNames).not.toContain("mcp_enabled_at");
    const metaCols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('user_meta')`.execute(db);
    expect(metaCols.rows.map((c) => c.name)).not.toContain("mcp_enabled");
    const left = await sql<{ id: string }>`SELECT id FROM nodes ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["fresh", "pre-existing"]);
    await mcpEnabledMigration.up(db); // leave the DB on the current shape
  });
});
