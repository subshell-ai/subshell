import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { up as up002 } from "@/db/migrations/0002-operator-ux.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/** Minimal typed shape of the sessions table for this migration's tests. */
interface MigrationDatabase {
  sessions: {
    id: string;
    lastOutputAt: string | null;
    notes: string | null;
  };
}

describe("0002 operator-ux migration", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/mote-002-${Math.random().toString(36).slice(2)}.db`;
    const sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<MigrationDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      // Mirrors the app db config (src/db/index.ts) so columns are camelCase.
      plugins: [new CamelCasePlugin()],
    });
    // Mirror 0001's sessions table shape minimally so ALTER works.
    await db.schema
      .createTable("sessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .execute();
    await up002(db);
  });
  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  it("adds last_output_at and notes columns", async () => {
    const row = await db.insertInto("sessions").values({ id: "s1" }).returningAll().executeTakeFirstOrThrow();
    // The above returning would have thrown if the columns did not exist.
    expect(row).toEqual({ id: "s1", lastOutputAt: null, notes: null });
  });
});
