import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as bookmarksMigration from "@/db/migrations/0007-bookmarks.js";
import * as favoritesMigration from "@/db/migrations/0012-favorites.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Migration 0012 introduces the generic favorites table and moves bookmarks
 * into it as `kind = 'directory'` rows. The "bookmarks exist" branch (an
 * upgraded install) and the fresh-install branch (0007 ran, but the test
 * skips it to simulate a DB without the table) must both work.
 */
async function migratedDb(withBookmarks: boolean) {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db);
  if (withBookmarks) await bookmarksMigration.up(db);
  return db;
}

describe("migration 0012-favorites", () => {
  it("creates favorites, moves bookmarks in as directory rows, drops bookmarks", async () => {
    const db = await migratedDb(true);
    await db
      .insertInto("bookmarks")
      .values([
        { id: "b1", userId: "u1", name: "mote repo", path: "/srv/mote", description: null },
        { id: "b2", userId: "u2", name: "other user", path: "/srv/other", description: null },
      ])
      .execute();

    await favoritesMigration.up(db);

    const rows = await db.selectFrom("favorites").selectAll().orderBy("ref").execute();
    expect(rows.map((r) => [r.userId, r.kind, r.ref, r.label])).toEqual([
      ["u1", "directory", "/srv/mote", "mote repo"],
      ["u2", "directory", "/srv/other", "other user"],
    ]);
    const tables = await db.selectFrom("sqlite_master").select("name").where("name", "=", "bookmarks").execute();
    expect(tables).toHaveLength(0);
    await db.destroy();
  });

  it("per-user uniqueness is by (user, kind, ref)", async () => {
    const db = await migratedDb(false);
    await favoritesMigration.up(db);
    const values = { id: "f1", userId: "u1", kind: "directory", ref: "/srv/x", label: null };
    await db.insertInto("favorites").values(values).execute();
    // Same user+kind+ref violates the unique index; a different kind does not.
    await expect(
      db
        .insertInto("favorites")
        .values({ ...values, id: "f2" })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
    await db
      .insertInto("favorites")
      .values({ id: "f3", userId: "u1", kind: "workspace", ref: "ws-1", label: null })
      .execute();
    expect(await db.selectFrom("favorites").select("id").execute()).toHaveLength(2);
    await db.destroy();
  });

  it("down() restores directory favorites as bookmark rows and drops favorites", async () => {
    const db = await migratedDb(true);
    await db
      .insertInto("bookmarks")
      .values({ id: "b1", userId: "u1", name: "mote repo", path: "/srv/mote", description: null })
      .execute();
    await favoritesMigration.up(db);
    await favoritesMigration.down(db);

    const bookmarks = await db.selectFrom("bookmarks").selectAll().execute();
    expect(bookmarks.map((b) => [b.name, b.path])).toEqual([["mote repo", "/srv/mote"]]);
    const tables = await db.selectFrom("sqlite_master").select("name").where("name", "=", "favorites").execute();
    expect(tables).toHaveLength(0);
    await db.destroy();
  });

  it("down() falls back to the full path as the name when the favorite has no label", async () => {
    const db = await migratedDb(false);
    await favoritesMigration.up(db);
    await db
      .insertInto("favorites")
      .values({ id: "f1", userId: "u1", kind: "directory", ref: "/home/theo/projects/widgets", label: null })
      .execute();
    await favoritesMigration.down(db);
    const bookmarks = await db.selectFrom("bookmarks").select(["name", "path"]).execute();
    expect(bookmarks).toEqual([{ name: "/home/theo/projects/widgets", path: "/home/theo/projects/widgets" }]);
    await db.destroy();
  });
});
