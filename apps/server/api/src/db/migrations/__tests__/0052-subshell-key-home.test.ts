import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as sshLaunchMigration from "@/db/migrations/0048-ssh-launch-and-saved-hosts.js";
import * as keyHomeMigration from "@/db/migrations/0052-subshell-key-home.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  subshells: Record<string, unknown>;
  user: Record<string, unknown>;
}

/**
 * Task 14's one storage change: `subshells` gains `key_home_node_id`, the
 * relay pane's key home A - the fact "Set up Subshell here" needs to re-open
 * the pairing that authorized this pane, minutes or hours after the 30 s
 * relay session itself is gone. NULL on every direct pane; the re-open act
 * names A-online as its own refusal cause, so the column must exist for that
 * reading, not be re-derived from the grant table.
 */
describe("migration 0052-subshell-key-home", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0052-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }),
    });
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@test')`.execute(db);
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    await subshellRenameMigration.up(db);
    await sshLaunchMigration.up(db);
    await keyHomeMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds key_home_node_id as a nullable column on the subshell row", async () => {
    const cols = await sql<{ name: string; notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info('subshells')
    `.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain("key_home_node_id");
    expect(cols.rows.find((r) => r.name === "key_home_node_id")?.notnull).toBe(0); // direct panes carry null
  });

  it("a row written without the column reads null; a relay row round-trips the A id", async () => {
    await db
      .insertInto("subshells")
      .values({
        id: "pane-direct",
        user_id: "u1",
        profile_id: "p1",
        harness_id: "ssh",
        name: "pane-direct",
        working_dir: "/tmp",
        ssh: '{"host":"d.example.test"}',
      } as never)
      .execute();
    await db
      .insertInto("subshells")
      .values({
        id: "pane-relay",
        user_id: "u1",
        profile_id: "p1",
        harness_id: "ssh",
        name: "pane-relay",
        working_dir: "/tmp",
        ssh: '{"host":"d.example.test"}',
        key_home_node_id: "node-a",
      } as never)
      .execute();
    const rows = await db.selectFrom("subshells").select(["id", "key_home_node_id"]).execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: "pane-direct", key_home_node_id: null },
        { id: "pane-relay", key_home_node_id: "node-a" },
      ]),
    );
  });

  it("down() removes only the new column", async () => {
    await keyHomeMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('subshells')`.execute(db);
    expect(cols.rows.map((r) => r.name)).not.toContain("key_home_node_id");
  });
});
