import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as migration from "@/db/migrations/0054-ssh-presets.js";
import { openSqliteDatabase } from "@/db/open-database.js";

test("SSH preset migration discards saved destinations, retains recents and agent presets", async () => {
  const db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(":memory:") }) });
  try {
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE nodes (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE presets (id TEXT PRIMARY KEY, name TEXT)`.execute(db);
    await sql`CREATE TABLE ssh_saved_hosts (id TEXT PRIMARY KEY, owner_user_id TEXT, destination TEXT, alias TEXT, node_id TEXT, saved_at TEXT, last_connect_at TEXT)`.execute(
      db,
    );
    await sql`INSERT INTO user VALUES ('u'), ('other')`.execute(db);
    await sql`INSERT INTO nodes VALUES ('n')`.execute(db);
    await sql`INSERT INTO presets VALUES ('agent', 'keep')`.execute(db);
    await sql`INSERT INTO ssh_saved_hosts VALUES ('saved', 'u', 'saved:22', NULL, 'n', 'now', 'now'), ('recent', 'u', 'recent:22', 'r', 'n', NULL, 'now')`.execute(
      db,
    );
    await migration.up(db);
    expect((await sql`SELECT * FROM ssh_recent_destinations`.execute(db)).rows).toEqual([
      { id: "recent", owner_user_id: "u", destination: "recent:22", alias: "r", node_id: "n", last_connect_at: "now" },
    ]);
    expect((await sql`SELECT * FROM ssh_presets`.execute(db)).rows).toEqual([]);
    expect((await sql`SELECT * FROM presets`.execute(db)).rows).toEqual([{ id: "agent", name: "keep" }]);
    await sql`INSERT INTO ssh_presets VALUES ('p', 'u', 'Work', NULL, 'n', 'host:22', NULL, 'original-alias', 'connecting', NULL, NULL, 'now', 'now')`.execute(
      db,
    );
    await expect(
      sql`INSERT INTO ssh_presets VALUES ('collision', 'u', 'work', NULL, 'n', 'host:22', NULL, 'original-alias', 'connecting', NULL, NULL, 'now', 'now')`.execute(
        db,
      ),
    ).rejects.toThrow("UNIQUE");
    await sql`INSERT INTO ssh_presets VALUES ('other-p', 'other', 'work', NULL, 'n', 'host:22', NULL, 'original-alias', 'connecting', NULL, NULL, 'now', 'now')`.execute(
      db,
    );
    await sql`DELETE FROM nodes WHERE id='n'`.execute(db);
    expect(
      (await sql<{ node_id: string | null }>`SELECT node_id FROM ssh_presets`.execute(db)).rows.every(
        (row) => row.node_id === null,
      ),
    ).toBe(true);
  } finally {
    await db.destroy();
  }
});
