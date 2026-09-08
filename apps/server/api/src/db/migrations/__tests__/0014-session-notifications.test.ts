import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as notificationsMigration from "@/db/migrations/0014-session-notifications.js";
import { openSqliteDatabase } from "@/db/open-database.js";

// Raw pragma query: Kysely would quote the table-valued function name in
// selectFrom("pragma_table_info(…)") (same helper the 0013 test uses).
function sessionColumns(db: Kysely<any>): Promise<{ name: string }[]> {
  return sql<{ name: string }>`SELECT name FROM pragma_table_info('sessions')`.execute(db).then((r) => r.rows);
}

async function migratedDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  return db;
}

describe("migration 0014-session-notifications", () => {
  it("adds notify (default 0) and waiting_since (null) to sessions; old rows unaffected", async () => {
    const db = await migratedDb();
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        userId: "u1",
        profileId: "p1",
        harnessId: "claude-code",
        name: "Old",
        workingDir: "/tmp",
        tmuxSocket: null,
      })
      .execute();
    await notificationsMigration.up(db);
    const row = await db
      .selectFrom("sessions")
      .select(["notify", "waitingSince"])
      .where("id", "=", "s1")
      .executeTakeFirst();
    expect(row).toEqual({ notify: 0, waitingSince: null });
    await notificationsMigration.down(db);
    const cols = await sessionColumns(db);
    expect(cols.map((c) => c.name)).not.toContain("notify");
    expect(cols.map((c) => c.name)).not.toContain("waiting_since");
    await db.destroy();
  });

  it("creates notifications_subscriptions with a unique endpoint", async () => {
    const db = await migratedDb();
    await notificationsMigration.up(db);
    await db
      .insertInto("notifications_subscriptions")
      .values({ id: "n1", userId: "u1", endpoint: "https://push/a", p256dh: "k", auth: "a", createdAt: "t" })
      .execute();
    // The same endpoint (a re-authorized browser) may not exist twice.
    await expect(
      db
        .insertInto("notifications_subscriptions")
        .values({ id: "n2", userId: "u2", endpoint: "https://push/a", p256dh: "k", auth: "a", createdAt: "t" })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
    await notificationsMigration.down(db);
    await expect(db.selectFrom("notifications_subscriptions").selectAll().execute()).rejects.toThrow(/no such table/i);
    await db.destroy();
  });
});
