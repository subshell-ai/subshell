import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { down as down0041, up as up0041 } from "@/db/migrations/0041-prompts.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * `prompts` (spec 2026-09-28): the saved-prompt library table. The shape this
 * test pins is the one every later layer is written against: required
 * description/body, `shared` a 0/1 column defaulting to 0 (everyone-or-none
 * is a column, not a shares table), and the (user, shared) index the two list
 * reads ride.
 */
interface PromptsMigrationDatabase {
  prompts: {
    id: string;
    userId: string;
    description: string;
    body: string;
    // Optional in the INSERT type so a bare values() row typechecks; the
    // point of this migration IS those three defaults.
    shared?: number;
    createdAt?: string;
    updatedAt?: string;
  };
}

describe("0041 prompts migration", () => {
  let dbFile: string;
  let sqlite: ReturnType<typeof openSqliteDatabase>;
  let db: Kysely<PromptsMigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0041-${Math.random().toString(36).slice(2)}.db`;
    sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<PromptsMigrationDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    // The FK target: better-auth's user table, minimally shaped so
    // `references("user.id")` resolves on this throwaway file (same posture
    // as the 0002 test mirroring 0001).
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    // The app enables foreign_keys; every prompt row below hangs off this one.
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@subshell.local')`.execute(db);
    await up0041(db as unknown as Kysely<unknown>);
  });

  afterAll(async () => {
    sqlite.close();
    await Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  it("inserts a row, defaults shared to 0 and both timestamps to ISO UTC", async () => {
    const row = await db
      .insertInto("prompts")
      .values({ id: "p1", userId: "u1", description: "Kickoff", body: "Start work" })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(row.shared).toBe(0);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.updatedAt).toBe(row.createdAt);
  });

  it("refuses a missing description or body (both NOT NULL)", async () => {
    await expect(
      db
        .insertInto("prompts")
        .values({ id: "p2", userId: "u1", body: "no label" } as never)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto("prompts")
        .values({ id: "p3", userId: "u1", description: "no body" } as never)
        .execute(),
    ).rejects.toThrow();
  });

  it("carries the (user_id, shared) index", async () => {
    const rows = await sql<{ name: string }>`SELECT name FROM pragma_index_list('prompts')`.execute(db);
    expect(rows.rows.map((r) => r.name)).toContain("idx_prompts_user_shared");
  });

  it("drops the table on down", async () => {
    await down0041(db as unknown as Kysely<unknown>);
    await expect(sql`SELECT * FROM prompts`.execute(db)).rejects.toThrow();
  });
});
