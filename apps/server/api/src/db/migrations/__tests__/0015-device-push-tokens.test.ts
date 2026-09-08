import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as deviceTokensMigration from "@/db/migrations/0015-device-push-tokens.js";
import { openSqliteDatabase } from "@/db/open-database.js";

async function migratedDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

describe("migration 0015-device-push-tokens", () => {
  it("creates device_tokens and enforces a unique token", async () => {
    const db = await migratedDb();
    await deviceTokensMigration.up(db);
    const insert = (token: string) =>
      db
        .insertInto("deviceTokens")
        .values({
          id: crypto.randomUUID(),
          userId: "u1",
          token,
          platform: "ios",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
        })
        .execute();
    await insert("ExponentPushToken[aaaa]");
    await expect(insert("ExponentPushToken[aaaa]")).rejects.toThrow();
    // Column names on the wire are snake_case; prove the migration really used them.
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('device_tokens')`
      .execute(db)
      .then((r) => r.rows);
    expect(cols.map((c) => c.name).sort()).toEqual(["created_at", "id", "platform", "token", "updated_at", "user_id"]);
    await db.destroy();
  });

  it("down() drops the table", async () => {
    const db = await migratedDb();
    await deviceTokensMigration.up(db);
    await deviceTokensMigration.down(db);
    await expect(sql`SELECT 1 FROM device_tokens`.execute(db)).rejects.toThrow();
    await db.destroy();
  });
});
