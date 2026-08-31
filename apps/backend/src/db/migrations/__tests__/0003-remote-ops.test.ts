import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Generated, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { up as up003 } from "@/db/migrations/0003-remote-ops.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Minimal typed shape of the sessions table for this migration's tests.
 * The DB itself is untyped (Kysely<unknown>); typing the insert/returning
 * chains explicitly lets the compiler verify the columns/projected keys.
 * Columns with DB defaults are `Generated` (optional on insert, non-null on
 * select) so the insert below omits them and the assertions read the defaults.
 */
interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  sessions: {
    id: string;
    alive: Generated<number>;
    exit_code: number | null;
    started_at: string | null;
    backoff_count: Generated<number>;
    next_restart_at: string | null;
    restart_on_exit: Generated<number>;
  };
  profiles: {
    id: string;
    restart_on_exit: Generated<number>;
  };
}

describe("0003 remote-ops migration", () => {
  let dbFile: string;
  let db: Kysely<unknown>;
  beforeAll(async () => {
    dbFile = `/tmp/mote-003-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await db.schema
      .createTable("sessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .execute();
    await db.schema
      .createTable("profiles")
      .addColumn("id", "text", (c) => c.primaryKey())
      .execute();
    await up003(db);
  });
  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
    db.destroy().catch(() => {});
  });

  it("adds liveness columns", async () => {
    const row = await db
      .$extendTables<MigrationDatabase>()
      .insertInto("sessions")
      .values({ id: "s1" })
      .returning(["alive", "exit_code", "started_at", "backoff_count", "next_restart_at", "restart_on_exit"])
      .executeTakeFirstOrThrow();
    expect(row.alive).toBe(1);
    expect(row.backoff_count).toBe(0);
    expect(row.restart_on_exit).toBe(0);
    expect(row.exit_code).toBeNull();
  });
  it("adds profiles.restart_on_exit", async () => {
    const row = await db
      .$extendTables<MigrationDatabase>()
      .insertInto("profiles")
      .values({ id: "p1" })
      .returning(["restart_on_exit"])
      .executeTakeFirstOrThrow();
    expect(row.restart_on_exit).toBe(0);
  });
});
