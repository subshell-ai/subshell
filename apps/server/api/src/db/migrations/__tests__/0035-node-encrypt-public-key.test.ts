import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import * as initMigration from "@/db/migrations/0001-init.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as encryptPublicKeyMigration from "@/db/migrations/0035-node-encrypt-public-key.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";

/**
 * Migrated on a CamelCasePlugin handle — the same transformation every real
 * runner (the boot migrator's `db`, and kysely-ctl via kysely.config.js, which
 * loads that same handle) applies: the migration's camelCase column name
 * becomes the snake_case physical column `encrypt_public_key`. A plugin-less
 * handle here would create a column the typed queries cannot even see, and
 * the test would pass while production could not read it.
 */
async function migratedDb(): Promise<Kysely<any>> {
  const fresh = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(fresh);
  await nodesMigration.up(fresh);
  return fresh;
}

/** Raw SQL is not transformed by the plugin, so this sees the PHYSICAL name. */
async function encryptColumnExists(fresh: Kysely<any>): Promise<boolean> {
  const cols = (await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(fresh)).rows;
  return cols.some((c) => c.name === "encrypt_public_key");
}

describe("migration 0035-node-encrypt-public-key", () => {
  it("adds the column where the typed queries resolve it; every pre-existing row reads NULL", async () => {
    // NULL is the whole migration story (spec 2026-09-24 §5): a node enrolled
    // before this column exists keeps its row untouched and reads NULL —
    // "legacy mode, held-updatable until it registers". No backfill, no
    // default, so a wrong key can never arrive by way of an upgrade.
    const fresh = await migratedDb();
    await fresh
      .insertInto("nodes")
      .values({
        id: "pre-existing",
        ownerUserId: "u",
        name: "pre-existing",
        kind: "agent",
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
      })
      .execute();
    expect(await encryptColumnExists(fresh)).toBe(false);

    await encryptPublicKeyMigration.up(fresh);
    // Physical name is `encrypt_public_key` and the CAMEL spelling reads it
    // through the plugin — exactly how `NodeTable.encryptPublicKey` queries it.
    expect(await encryptColumnExists(fresh)).toBe(true);
    const row = await fresh
      .selectFrom("nodes")
      .select("encryptPublicKey")
      .where("id", "=", "pre-existing")
      .executeTakeFirstOrThrow();
    expect(row.encryptPublicKey).toBeNull();

    // down() is the inverse, so kysely-ctl's undo path stays honest.
    await encryptPublicKeyMigration.down(fresh);
    expect(await encryptColumnExists(fresh)).toBe(false);
    await fresh.destroy();
  });

  it("is registered in the boot map (both-places rule) and round-trips the repository write", async () => {
    // The boot migrator reads the STATIC map in migrate.ts; a file present on
    // disk but missing from the map never applies to a shared/production DB,
    // so ask the migrated database directly what it actually ran.
    await runMigrations();
    const applied = (await sql<{ name: string }>`select name from kysely_migration`.execute(db)).rows;
    expect(applied.map((r) => r.name)).toContain("0035-node-encrypt-public-key");

    // And the column carries the opaque base64 the enroll path will write,
    // byte for byte, through the repository's typed create/findById.
    const repo = new NodesRepository(db);
    const id = `enc-${crypto.randomUUID()}`;
    await repo.create({ id, ownerUserId: "u", name: id, kind: "agent", encryptPublicKey: "eyJhbGciOiJY" });
    expect((await repo.findById(id))?.encryptPublicKey).toBe("eyJhbGciOiJY");
    await repo.deleteById(id);
  });
});
