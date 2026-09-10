import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as dropHarnessPlugins from "@/db/migrations/0025-drop-harness-plugins.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * The last of the enable state (spec 2026-09-09 §12).
 *
 * `harness_plugins` was the per-instance on/off flag for each harness on the
 * control-plane host, and the reason `local` was the one node resolved
 * differently from every other. It has a plugins directory now, so what it
 * offers is what it has installed.
 */
async function migratedDb(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

async function hasTable(db: Kysely<any>, table: string): Promise<boolean> {
  const r = await sql<{
    n: number;
  }>`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=${table}`.execute(db);
  return (r.rows[0]?.n ?? 0) > 0;
}

async function columns(db: Kysely<any>, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return r.rows.map((c) => c.name);
}

describe("migration 0025-drop-harness-plugins", () => {
  it("drops the table", async () => {
    const db = await migratedDb();
    try {
      expect(await hasTable(db, "harness_plugins")).toBe(true);
      await dropHarnessPlugins.up(db);
      expect(await hasTable(db, "harness_plugins")).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it("runs twice without failing", async () => {
    // `ifExists`: a partially migrated database, or a down-then-up cycle,
    // must not be a hard stop at boot.
    const db = await migratedDb();
    try {
      await dropHarnessPlugins.up(db);
      await dropHarnessPlugins.up(db);
      expect(await hasTable(db, "harness_plugins")).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it("recreates it empty on down, with the columns 0001-init gave it", async () => {
    const db = await migratedDb();
    try {
      await sql`INSERT INTO harness_plugins (id, enabled) VALUES ('claude-code', 0)`.execute(db);
      await dropHarnessPlugins.up(db);
      await dropHarnessPlugins.down(db);

      expect(await columns(db, "harness_plugins")).toEqual(["id", "enabled", "created_at", "updated_at"]);
      // Empty by necessity, and the inserted row above is the point: nothing
      // left in the schema records which harnesses an operator switched off,
      // so a downgrade lands on the lazy default rather than a reconstruction
      // this migration has no evidence for.
      const rows = await sql<{ n: number }>`SELECT count(*) AS n FROM harness_plugins`.execute(db);
      expect(rows.rows[0]?.n).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});
