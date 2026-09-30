import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { up as up0040 } from "@/db/migrations/0040-prompts.js";
import { down as down0041, up as up0041 } from "@/db/migrations/0041-prompt-stacks.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * `prompt_stacks` + `prompt_stack_items` (spec 2026-09-29). What this pins is
 * what every later layer leans on: the exactly-one-of prompt_id/body CHECK,
 * the per-stack ordinal uniqueness, and BOTH cascades the design is named for -
 * deleting a PROMPT sweeps its member rows and leaves the stack (possibly
 * empty; that is the rule, in SQLite, not in app code), and deleting a stack
 * sweeps its members.
 */
interface StacksMigrationDatabase {
  prompts: {
    id: string;
    userId: string;
    description: string;
    body: string;
  };
  prompt_stacks: {
    id: string;
    userId: string;
    label: string;
    shared?: number;
    createdAt?: string;
    updatedAt?: string;
  };
  prompt_stack_items: {
    id: string;
    stackId: string;
    ordinal: number;
    promptId: string | null;
    body: string | null;
    description: string | null;
  };
}

describe("0041 prompt-stacks migration", () => {
  let dbFile: string;
  let sqlite: ReturnType<typeof openSqliteDatabase>;
  let db: Kysely<StacksMigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0041-${Math.random().toString(36).slice(2)}.db`;
    sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<StacksMigrationDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    // The FK targets, the 0040-test posture: the real 0040 up builds the
    // prompts table, so this test cascades against the shipped shape.
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@subshell.local')`.execute(db);
    await up0040(db as unknown as Kysely<unknown>);
    await up0041(db as unknown as Kysely<unknown>);
  });

  afterAll(async () => {
    sqlite.close();
    await Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  async function mkStack(id: string) {
    await db
      .insertInto("prompt_stacks")
      .values({ id, userId: "u1", label: `Stack ${id}` })
      .execute();
  }

  async function mkPrompt(id: string) {
    await db
      .insertInto("prompts")
      .values({ id, userId: "u1", description: `P ${id}`, body: "text" })
      .execute();
  }

  it("inserts a stack, defaults shared to 0 and both timestamps to ISO UTC", async () => {
    await mkStack("s-defaults");
    const row = await db
      .selectFrom("prompt_stacks")
      .selectAll()
      .where("id", "=", "s-defaults")
      .executeTakeFirstOrThrow();
    expect(row.shared).toBe(0);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.updatedAt).toBe(row.createdAt);
  });

  it("refuses an item that is both-reference-and-inline, or neither", async () => {
    await mkStack("s-check");
    await mkPrompt("p-check");
    await expect(
      db
        .insertInto("prompt_stack_items")
        .values({
          id: "i1",
          stackId: "s-check",
          ordinal: 0,
          promptId: "p-check",
          body: "inline too",
          description: null,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto("prompt_stack_items")
        .values({ id: "i2", stackId: "s-check", ordinal: 0, promptId: null, body: null, description: null })
        .execute(),
    ).rejects.toThrow();
  });

  it("accepts a reference row and an inline row side by side", async () => {
    await mkStack("s-both");
    await mkPrompt("p-both");
    await db
      .insertInto("prompt_stack_items")
      .values([
        { id: "i-ref", stackId: "s-both", ordinal: 0, promptId: "p-both", body: null, description: null },
        { id: "i-inline", stackId: "s-both", ordinal: 1, promptId: null, body: "my own text", description: "Note" },
      ])
      .execute();
    const items = await db
      .selectFrom("prompt_stack_items")
      .selectAll()
      .where("stackId", "=", "s-both")
      .orderBy("ordinal", "asc")
      .execute();
    expect(items.map((i) => i.id)).toEqual(["i-ref", "i-inline"]);
  });

  it("refuses a duplicate ordinal within one stack, allows the same ordinal across stacks", async () => {
    await mkStack("s-ord1");
    await mkStack("s-ord2");
    await db
      .insertInto("prompt_stack_items")
      .values({ id: "o1", stackId: "s-ord1", ordinal: 0, promptId: null, body: "a", description: null })
      .execute();
    await expect(
      db
        .insertInto("prompt_stack_items")
        .values({ id: "o2", stackId: "s-ord1", ordinal: 0, promptId: null, body: "b", description: null })
        .execute(),
    ).rejects.toThrow();
    await db
      .insertInto("prompt_stack_items")
      .values({ id: "o3", stackId: "s-ord2", ordinal: 0, promptId: null, body: "c", description: null })
      .execute();
  });

  it("deleting a PROMPT sweeps its member rows and LEAVES THE STACK (the empty-stack rule)", async () => {
    await mkStack("s-cascade");
    await mkPrompt("p-gone");
    await db
      .insertInto("prompt_stack_items")
      .values({ id: "i-gone", stackId: "s-cascade", ordinal: 0, promptId: "p-gone", body: null, description: null })
      .execute();
    await db.deleteFrom("prompts").where("id", "=", "p-gone").execute();
    const items = await db.selectFrom("prompt_stack_items").selectAll().where("id", "=", "i-gone").execute();
    expect(items).toHaveLength(0);
    const stack = await db.selectFrom("prompt_stacks").selectAll().where("id", "=", "s-cascade").executeTakeFirst();
    expect(stack).toBeDefined(); // the stack survives, empty
  });

  it("deleting a stack sweeps its member rows", async () => {
    await mkStack("s-drop");
    await db
      .insertInto("prompt_stack_items")
      .values({ id: "i-drop", stackId: "s-drop", ordinal: 0, promptId: null, body: "x", description: null })
      .execute();
    await db.deleteFrom("prompt_stacks").where("id", "=", "s-drop").execute();
    expect(await db.selectFrom("prompt_stack_items").selectAll().where("id", "=", "i-drop").execute()).toHaveLength(0);
  });

  it("carries both indexes", async () => {
    const stacks = await sql<{ name: string }>`SELECT name FROM pragma_index_list('prompt_stacks')`.execute(db);
    expect(stacks.rows.map((r) => r.name)).toContain("idx_prompt_stacks_user_shared");
    const items = await sql<{ name: string }>`SELECT name FROM pragma_index_list('prompt_stack_items')`.execute(db);
    expect(items.rows.map((r) => r.name)).toContain("idx_prompt_stack_items_prompt");
  });

  it("drops both tables on down", async () => {
    await down0041(db as unknown as Kysely<unknown>);
    await expect(sql`SELECT * FROM prompt_stacks`.execute(db)).rejects.toThrow();
    await expect(sql`SELECT * FROM prompt_stack_items`.execute(db)).rejects.toThrow();
  });
});
