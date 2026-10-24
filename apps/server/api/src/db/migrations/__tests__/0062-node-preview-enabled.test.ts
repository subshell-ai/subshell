import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as previewEnabledMigration from "@/db/migrations/0062-node-preview-enabled.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  nodes: Record<string, unknown>;
}

/**
 * The per-node preview switch columns (pane-preview spec Task 3). Default 0 is
 * the whole upgrade story, cloned from 0047's doctrine: a node enrolled before
 * this migration (and the seeded local row) reads OFF, because watching panes
 * is opt-in per machine: preview exposes terminal content, so an upgrade must
 * never turn it on anywhere.
 */
describe("migration 0062-node-preview-enabled", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Insert a node row the way the pre-0062 repository did - no preview fields at all. */
  const legacyNode = (id: string) =>
    db
      .insertInto("nodes")
      .values({
        id,
        owner_user_id: "u1",
        name: id,
        kind: "agent",
        created_at: "2026-10-21T00:00:00.000Z",
        updated_at: "2026-10-21T00:00:00.000Z",
      })
      .execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0062-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    // Written BEFORE the columns exist - the upgrade case this test is about.
    await legacyNode("pre-existing");
    await previewEnabledMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds the two columns", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("preview_enabled");
    expect(names).toContain("preview_enabled_at");
  });

  it("leaves every pre-existing node with preview off (default-off doctrine)", async () => {
    const r = await sql<{
      preview_enabled: number;
      preview_enabled_at: string | null;
    }>`SELECT preview_enabled, preview_enabled_at FROM nodes WHERE id = 'pre-existing'`.execute(db);
    expect(r.rows[0]).toEqual({ preview_enabled: 0, preview_enabled_at: null });
  });

  it("defaults a row written without the columns to 0", async () => {
    await legacyNode("fresh");
    const r = await sql<{ preview_enabled: number }>`SELECT preview_enabled FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0].preview_enabled).toBe(0);
  });

  it("stores the flag with its stamp", async () => {
    await db
      .updateTable("nodes")
      .set({ preview_enabled: 1, preview_enabled_at: "2026-10-21T10:00:00.000Z" })
      .where("id", "=", "fresh")
      .execute();
    const r = await sql<{
      preview_enabled: number;
      preview_enabled_at: string;
    }>`SELECT preview_enabled, preview_enabled_at FROM nodes WHERE id = 'fresh'`.execute(db);
    expect(r.rows[0]).toEqual({ preview_enabled: 1, preview_enabled_at: "2026-10-21T10:00:00.000Z" });
  });

  it("down removes both columns and leaves the rows", async () => {
    await previewEnabledMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("preview_enabled");
    expect(names).not.toContain("preview_enabled_at");
    const left = await sql<{ id: string }>`SELECT id FROM nodes ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["fresh", "pre-existing"]);
    await previewEnabledMigration.up(db); // leave the DB on the current shape
  });
});
