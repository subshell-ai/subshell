import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/** Raw pragma read of a table's columns (Kysely would quote the TVF name). */
async function columns(db: Kysely<any>, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return r.rows.map((c) => c.name);
}

async function migratedDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

describe("migration 0016-session-sharing", () => {
  it("adds user_meta.notify_enabled defaulting to 1", async () => {
    const db = await migratedDb();
    await db.insertInto("userMeta").values({ userId: "u1", role: "user" }).execute();
    await sharingMigration.up(db);
    expect(await columns(db, "user_meta")).toContain("notify_enabled");
    const row = await db
      .selectFrom("userMeta")
      .select("notifyEnabled")
      .where("userId", "=", "u1")
      .executeTakeFirstOrThrow();
    expect(row.notifyEnabled).toBe(1);
  });

  it("creates session_shares (FK to a real session) and drops it on down()", async () => {
    const db = await migratedDb();
    await sharingMigration.up(db);
    expect((await columns(db, "session_shares")).length).toBeGreaterThan(0);
    // A parent session so the FK is satisfied.
    await db
      .insertInto("sessions")
      .values({
        id: "sess-1",
        userId: "u1",
        profileId: "p1",
        harnessId: "pi",
        name: "S",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
    await db
      .insertInto("sessionShares")
      .values({
        id: "share-1",
        sessionId: "sess-1",
        granteeUserId: null,
        permission: "view",
        createdBy: "u1",
        createdAt: "now",
      })
      .execute();
    await sharingMigration.down(db);
    const tables = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='table' AND name='session_shares'`.execute(db);
    expect(tables.rows).toHaveLength(0);
  });
});
