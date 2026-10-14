import { expect, test } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db as freshDb } from "@/db/index.js";
import * as grants from "@/db/migrations/0050-ssh-grants.js";
import * as destinations from "@/db/migrations/0051-ssh-request-destination.js";
import * as removal from "@/db/migrations/0053-drop-ssh-grants.js";
import { openSqliteDatabase } from "@/db/open-database.js";

test("SSH grant removal upgrades existing stores and preserves destination trust, saved hosts and audit", async () => {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  try {
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO user VALUES ('u')`.execute(db);
    await grants.up(db);
    await destinations.up(db);
    await sql`CREATE TABLE ssh_saved_hosts (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE audit_events (id TEXT PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO ssh_saved_hosts VALUES ('saved')`.execute(db);
    await sql`INSERT INTO audit_events VALUES ('audit')`.execute(db);
    await sql`INSERT INTO ssh_host_pins VALUES ('pin','u','host:22','key','now','now')`.execute(db);
    await sql`INSERT INTO ssh_key_grants VALUES ('grant','u','old','node','host','[]','manual','now','now')`.execute(
      db,
    );
    await sql`INSERT INTO ssh_grant_requests VALUES ('request','u','node','host',NULL,'pane','b','future','pending','now','host:22')`.execute(
      db,
    );
    await removal.up(db);
    const names = (await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`.execute(db)).rows.map(
      (row) => row.name,
    );
    expect(names).not.toContain("ssh_key_grants");
    expect(names).not.toContain("ssh_grant_requests");
    for (const table of ["ssh_host_pins", "ssh_saved_hosts", "audit_events"]) {
      expect((await sql.raw(`SELECT * FROM ${table}`).execute(db)).rows).toHaveLength(1);
    }
    await expect(removal.down()).rejects.toThrow("irreversible");
  } finally {
    await db.destroy();
  }
});

test("fresh migration chain contains trust and no SSH permission tables", async () => {
  await ensureMigratedTestDb();
  const tables = (
    await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`.execute(freshDb)
  ).rows.map((row) => row.name);
  expect(tables).toContain("ssh_host_pins");
  expect(tables).toContain("ssh_saved_hosts");
  expect(tables).not.toContain("ssh_key_grants");
  expect(tables).not.toContain("ssh_grant_requests");
});
