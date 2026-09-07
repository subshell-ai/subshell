import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sessionHarnessIdMigration from "@/db/migrations/0013-session-harness-id.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Migration 0013 adds `sessions.harness_session_id` — the pinned harness
 * conversation id behind restart-resume. Nullable with no default (old rows
 * simply have no resume lineage), and `down()` must drop it cleanly.
 */
async function migratedDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

function columns(db: Kysely<any>): Promise<{ name: string }[]> {
  return sql<{ name: string }>`SELECT name FROM pragma_table_info('sessions')`.execute(db).then((r) => r.rows);
}

describe("migration 0013-session-harness-id", () => {
  it("adds a nullable harness_session_id; existing rows read back null", async () => {
    const db = await migratedDb();
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p1",
        harnessId: "claude-code",
        name: "Old row",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();

    await sessionHarnessIdMigration.up(db);

    expect((await columns(db)).map((c) => c.name)).toContain("harness_session_id");
    // The suite's CamelCasePlugin maps the snake column back to camelCase.
    const row = await db.selectFrom("sessions").select("harnessSessionId").where("id", "=", "s1").executeTakeFirst();
    expect(row?.harnessSessionId).toBeNull();

    await sessionHarnessIdMigration.down(db);
    expect((await columns(db)).map((c) => c.name)).not.toContain("harness_session_id");
    await db.destroy();
  });
});
