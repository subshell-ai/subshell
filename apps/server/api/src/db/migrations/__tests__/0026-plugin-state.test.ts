import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as pluginStateMigration from "@/db/migrations/0026-plugin-state.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * The instance-level `enabled` flag (spec 2026-09-10 §6.1).
 *
 * One table for the whole instance: `plugin_id` PK, `enabled`, `updated_at`.
 * The two properties this pins are the ones the gate depends on:
 *
 * - an ABSENT row means enabled, so installing writes nothing and the default
 *   is on. The table never needs backfilling when a plugin lands;
 * - the flag is NOT in `install.json`, which the installer rewrites on every
 *   install — a disable that a reinstall silently cleared would be the
 *   phase-5 spec's node-settings trap all over again.
 *
 * This is the CREATE half of migration 0026 (Task 9 owns it: the server needs
 * the table to answer PATCH the moment the instance route exists). The drop
 * of the per-node mirror joins this same file in Task 10, which is why `up`
 * is written to survive being applied beside a half-migrated database.
 */
async function migratedDb(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

async function columns(db: Kysely<any>, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return r.rows.map((c) => c.name);
}

describe("migration 0026-plugin-state", () => {
  it("creates plugin_state with the three load-bearing columns", async () => {
    const db = await migratedDb();
    try {
      await pluginStateMigration.up(db);
      expect(await columns(db, "plugin_state")).toEqual(["plugin_id", "enabled", "updated_at"]);
    } finally {
      await db.destroy();
    }
  });

  it("defaults enabled to 1 and keys the table by plugin id", async () => {
    const db = await migratedDb();
    try {
      await pluginStateMigration.up(db);
      await sql`INSERT INTO plugin_state (plugin_id, updated_at) VALUES ('claude-code', '2026-09-10T00:00:00Z')`.execute(
        db,
      );
      const r = await sql<{
        enabled: number;
      }>`SELECT enabled FROM plugin_state WHERE plugin_id = 'claude-code'`.execute(db);
      expect(r.rows[0]?.enabled).toBe(1);
      // PK: a second row for the same plugin is a hard error, not a shadow.
      await expect(
        sql`INSERT INTO plugin_state (plugin_id, enabled, updated_at) VALUES ('claude-code', 0, 'x')`.execute(db),
      ).rejects.toThrow();
    } finally {
      await db.destroy();
    }
  });

  it("runs twice without failing", async () => {
    // `ifNotExists`: Task 10 will add the drop half to this same unreleased
    // file, and a dev database that already applied the create half must not
    // hard-stop at boot when the extended file re-runs.
    const db = await migratedDb();
    try {
      await pluginStateMigration.up(db);
      await pluginStateMigration.up(db);
      expect(await columns(db, "plugin_state")).toContain("plugin_id");
    } finally {
      await db.destroy();
    }
  });
});
