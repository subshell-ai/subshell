import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as plaintextMigration from "@/db/migrations/0033-setup-key-plaintext.js";
import { openSqliteDatabase } from "@/db/open-database.js";

async function dbAt0017(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  await nodesMigration.up(db);
  return db;
}

async function columns(db: Kysely<any>, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return r.rows.map((c) => c.name);
}

/** The columns an index covers, each with whether the index is UNIQUE. */
async function indexColumns(db: Kysely<any>, index: string): Promise<{ column: string; isUnique: number }[]> {
  const r = await sql<{ column: string; isUnique: number }>`
    SELECT i.name AS column, l."unique" AS isUnique
    FROM pragma_index_list('node_setup_keys') l
    JOIN pragma_index_info(l.name) i
    WHERE l.name = ${index}
  `.execute(db);
  return r.rows;
}

const row = {
  id: "k1",
  ownerUserId: "u1",
  createdAt: "2026-09-17T00:00:00.000Z",
  expiresAt: "2026-09-18T00:00:00.000Z",
  usedAt: null,
  consumedNodeId: null,
};

describe("migration 0033-setup-key-plaintext", () => {
  it("replaces label + key_hash with the key itself", async () => {
    const db = await dbAt0017();
    await plaintextMigration.up(db);
    const cols = await columns(db, "node_setup_keys");
    expect(cols).toContain("key");
    expect(cols).not.toContain("label");
    expect(cols).not.toContain("key_hash");
  });

  it("wipes every outstanding key", async () => {
    const db = await dbAt0017();
    await db
      .insertInto("node_setup_keys")
      .values({ ...row, label: "mac mini", keyHash: "abc" })
      .execute();
    await plaintextMigration.up(db);
    const r = await db.selectFrom("node_setup_keys").selectAll().execute();
    expect(r).toEqual([]);
  });

  it("puts the UNIQUE index on the key, and `key` is NOT NULL", async () => {
    const db = await dbAt0017();
    await plaintextMigration.up(db);
    expect(await indexColumns(db, "node_setup_keys_key_idx")).toEqual([{ column: "key", isUnique: 1 }]);
    // The old digest index is gone with the column it covered.
    expect(await indexColumns(db, "node_setup_keys_key_hash_idx")).toEqual([]);

    await db
      .insertInto("node_setup_keys")
      .values({ ...row, key: "nsk_first" })
      .execute();
    // A duplicate is refused — the property the digest index used to buy.
    await expect(
      db
        .insertInto("node_setup_keys")
        .values({ ...row, id: "k2", key: "nsk_first" })
        .execute(),
    ).rejects.toThrow();

    // And a key-less row cannot exist: no `DEFAULT ''` snuck in with the rebuild.
    await expect(
      db
        .insertInto("node_setup_keys")
        .values({ ...row, id: "k3" })
        .execute(),
    ).rejects.toThrow();
  });

  it("down restores the old shape (empty, since the rebuild dropped the rows)", async () => {
    const db = await dbAt0017();
    await db
      .insertInto("node_setup_keys")
      .values({ ...row, label: "mac mini", keyHash: "abc" })
      .execute();
    await plaintextMigration.up(db);
    await plaintextMigration.down(db);
    const cols = await columns(db, "node_setup_keys");
    expect(cols).toContain("label");
    expect(cols).toContain("key_hash");
    expect(cols).not.toContain("key");
    expect(await db.selectFrom("node_setup_keys").selectAll().execute()).toEqual([]);
    expect(await indexColumns(db, "node_setup_keys_key_hash_idx")).toEqual([{ column: "key_hash", isUnique: 1 }]);
  });
});
