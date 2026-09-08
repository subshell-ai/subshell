import { afterEach, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { openSqliteDatabase } from "@/db/open-database.js";

// We open a fresh :memory: database per test; the dialect is constructed per test.
function createKysely() {
  const db = openSqliteDatabase(":memory:");
  const kysely = new Kysely<TestDb>({
    dialect: new BunSqliteDialect({ database: db }),
  });
  return { db, kysely };
}

interface Users {
  id?: number;
  name?: string;
  email?: string;
  createdAt?: string;
}
interface TestDb {
  users: Users;
  posts: {
    id: string;
    user_id: string;
  };
}

afterEach(() => {
  // nothing shared; each test makes its own DB
});

describe("BunSqliteDialect", () => {
  it("creates a table and inserts/selects rows", async () => {
    const { db, kysely } = createKysely();
    await db.exec("drop table if exists users");
    await kysely.schema
      .createTable("users")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text")
      .addColumn("email", "text")
      .execute();

    const ins = await kysely
      .insertInto("users")
      .values({ name: "bob", email: "bob@example.com" })
      .executeTakeFirstOrThrow();
    expect(ins.insertId).toEqual(1n);

    const rows = await kysely.selectFrom("users").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "bob", email: "bob@example.com" });
  });

  it("supports transactions (commit)", async () => {
    const { db, kysely } = createKysely();
    await db.exec("drop table if exists users");
    await kysely.schema
      .createTable("users")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text")
      .execute();

    await kysely.transaction().execute(async (trx) => {
      await trx.insertInto("users").values({ name: "alice" }).execute();
      await trx.insertInto("users").values({ name: "carol" }).execute();
    });

    const count = (await kysely.selectFrom("users").select(sql`count(*)`.as("c")).executeTakeFirstOrThrow()) as {
      c: number;
    };
    expect(count.c).toEqual(2);
  });

  it("rolls back a transaction on error", async () => {
    const { db, kysely } = createKysely();
    await db.exec("drop table if exists users");
    await kysely.schema
      .createTable("users")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text")
      .execute();

    await expect(
      kysely.transaction().execute(async (trx) => {
        await trx.insertInto("users").values({ name: "dave" }).execute();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const count = (await kysely.selectFrom("users").select(sql`count(*)`.as("c")).executeTakeFirstOrThrow()) as {
      c: number;
    };
    expect(count.c).toEqual(0);
  });

  it("honors foreign keys", async () => {
    const { db, kysely } = createKysely();
    await db.exec("drop table if exists posts");
    await db.exec("drop table if exists users");
    await kysely.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .execute();
    await kysely.schema
      .createTable("posts")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("user_id", "text", (col) => col.references("users.id"))
      .execute();

    await expect(kysely.insertInto("posts").values({ id: "p1", user_id: "missing" }).execute()).rejects.toThrow(
      /FOREIGN KEY/i,
    );
  });

  it("supports raw sql and returning (insert returning)", async () => {
    const { db, kysely } = createKysely();
    await db.exec("drop table if exists users");
    await kysely.schema
      .createTable("users")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text")
      .addColumn("email", "text")
      .execute();

    const returned = await kysely
      .insertInto("users")
      .values({ name: "eve", email: "eve@example.com" })
      .returning(["name"])
      .executeTakeFirstOrThrow();
    expect(returned.name).toEqual("eve");
  });
});
