import { type Kysely, sql } from "kysely";

/**
 * Bookmarks: per-user saved working directories, replacing the install-wide
 * `mounts` table.
 *
 * A mount only ever filled the working-directory field on the new-session
 * form — it constrained nothing — so it was a bookmark wearing Docker's
 * vocabulary. Two changes follow from naming it honestly: the rows belong to
 * a user instead of the install (anyone can save their own; no admin round
 * trip), and the advisory `access` column is gone. It was documented as
 * unenforced in its own helper text, and "read-only" means even less for a
 * shortcut someone saved for themselves than it did for a shared registry.
 *
 * `user_id` is a plain column with no foreign key, matching `workspaces` and
 * `recent_paths` — better-auth owns the `user` table and migrates it
 * separately, so the app's schema does not reference it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("bookmarks")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createIndex("idx_bookmarks_user_name")
    .on("bookmarks")
    .columns(["user_id", "name"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_bookmarks_user_path")
    .on("bookmarks")
    .columns(["user_id", "path"])
    .unique()
    .execute();

  await copyMountsToEveryUser(db);

  await db.schema.dropTable("mounts").ifExists().execute();
}

/**
 * Gives every existing user their own copy of each mount.
 *
 * Mounts were visible to everyone, so a per-user copy each is what preserves
 * what people could actually see. Both tables are checked for existence
 * first: `runMigrations()` runs before `runAuthMigrations()` at boot, so on a
 * fresh database better-auth's `user` table does not exist yet — and there is
 * nothing to copy then anyway.
 */
async function copyMountsToEveryUser(db: Kysely<any>): Promise<void> {
  if (!(await tableExists(db, "mounts")) || !(await tableExists(db, "user"))) return;

  await sql`
    INSERT INTO bookmarks (id, user_id, name, path, description, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), u.id, m.name, m.path, m.description, m.created_at, m.updated_at
    FROM mounts m
    CROSS JOIN user u
  `.execute(db);
}

/** True when `name` is a table in this database. */
async function tableExists(db: Kysely<any>, name: string): Promise<boolean> {
  const result = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(db);
  return result.rows.length > 0;
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("bookmarks").execute();
}
