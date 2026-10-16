import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as presetsMigration from "@/db/migrations/0054-ssh-presets.js";
import * as presetForwardsMigration from "@/db/migrations/0056-ssh-preset-forwards.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * The preset forwards column (spec 2026-10-15 §7): nullable JSON, so every
 * preset written before the migration simply has none, and NULL is the same
 * reading as the explicit clear.
 */
test("SSH preset forwards column arrives nullable and leaves cleanly", async () => {
  const db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(":memory:") }) });
  try {
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE nodes (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE presets (id TEXT PRIMARY KEY, name TEXT)`.execute(db);
    await sql`CREATE TABLE ssh_saved_hosts (id TEXT PRIMARY KEY, owner_user_id TEXT, destination TEXT, alias TEXT, node_id TEXT, saved_at TEXT, last_connect_at TEXT)`.execute(
      db,
    );
    await sql`INSERT INTO user VALUES ('u')`.execute(db);
    await sql`INSERT INTO nodes VALUES ('n')`.execute(db);
    await presetsMigration.up(db);
    // A preset written BEFORE 0056, the upgrade case.
    await sql`INSERT INTO ssh_presets VALUES ('p', 'u', 'Work', NULL, 'n', 'host:22', NULL, NULL, 'connecting', NULL, NULL, 'now', 'now')`.execute(
      db,
    );

    await presetForwardsMigration.up(db);
    const cols = await sql<{
      name: string;
      notnull: number;
    }>`SELECT name, "notnull" FROM pragma_table_info('ssh_presets')`.execute(db);
    const fwd = cols.rows.find((c) => c.name === "forwards");
    expect(fwd).toBeDefined();
    expect(fwd?.notnull).toBe(0);
    const row = await sql<{ forwards: string | null }>`SELECT forwards FROM ssh_presets WHERE id='p'`.execute(db);
    expect(row.rows[0]?.forwards).toBeNull();

    await presetForwardsMigration.down(db);
    const after = await sql<{ name: string }>`SELECT name FROM pragma_table_info('ssh_presets')`.execute(db);
    expect(after.rows.map((c) => c.name)).not.toContain("forwards");
  } finally {
    await db.destroy();
  }
});
