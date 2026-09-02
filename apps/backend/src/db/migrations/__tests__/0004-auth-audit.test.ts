import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, type Generated, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { up as up004 } from "@/db/migrations/0004-auth-audit.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Minimal typed shape of the two new tables for this migration's tests.
 * The DB itself is untyped (Kysely<unknown>); typing the insert/returning
 * chains explicitly lets the compiler verify the columns/projected keys.
 * Columns with DB defaults are `Generated` (optional on insert, non-null on
 * select) so the inserts below omit them and the assertions read the defaults.
 */
interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  authAttempts: {
    email: string;
    attemptCount: Generated<number>;
    lastAttemptAt: string | null;
  };
  auditEvents: {
    id: string;
    actorUserId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadataJson: string | null;
    createdAt: string;
  };
}

describe("0004 auth-audit migration", () => {
  let dbFile: string;
  let db: Kysely<unknown>;
  beforeAll(async () => {
    dbFile = `/tmp/subshell-004-${Math.random().toString(36).slice(2)}.db`;
    // Mirrors the app db config (src/db/index.ts) so columns map camelCase.
    db = new Kysely({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }),
      plugins: [new CamelCasePlugin()],
    });
    await up004(db);
  });
  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
    db.destroy().catch(() => {});
  });

  it("creates auth_attempts with count default and nullable timestamp", async () => {
    const row = await db
      .$extendTables<MigrationDatabase>()
      .insertInto("authAttempts")
      .values({ email: "attacker@example.com" })
      .returning(["attemptCount", "lastAttemptAt"])
      .executeTakeFirstOrThrow();
    expect(row.attemptCount).toBe(0);
    expect(row.lastAttemptAt).toBeNull();
  });

  it("creates audit_events and can store a full event", async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .$extendTables<MigrationDatabase>()
      .insertInto("auditEvents")
      .values({
        id,
        actorUserId: "user-1",
        action: "session.delete",
        targetType: "session",
        targetId: "sess-1",
        metadataJson: JSON.stringify({ reason: "test" }),
        createdAt: now,
      })
      .execute();
    const row = await db
      .$extendTables<MigrationDatabase>()
      .selectFrom("auditEvents")
      .select(["actorUserId", "action", "targetType", "targetId", "metadataJson", "createdAt"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.action).toBe("session.delete");
    expect(row.targetId).toBe("sess-1");
    expect(row.createdAt).toBe(now);
  });
});
