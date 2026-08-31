import { type Kysely, sql } from "kysely";

/**
 * A generic per-user favorites table, replacing bookmarks.
 *
 * A bookmark was a saved working directory with its own table, CRUD API and
 * page. The folder picker now stars paths in place, and rather than bolt a
 * `favorite` flag onto `recent_paths` (which only ever describes *used*
 * paths, and only one kind of thing), favorites get their own polymorphic
 * table: (user, kind, ref) — `kind` is "directory" today, and the ref is the
 * absolute path; a future session/workspace favorite reuses the same table
 * with the entity id as ref. A favorite is independent of recency: starring
 * a never-used path works, and a starred path never ages out.
 *
 * Existing bookmarks move over as directory favorites (name → label). Then
 * `bookmarks` is dropped; migration 0007 stays in the boot map untouched —
 * history is not rewritten.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("favorites")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("ref", "text", (col) => col.notNull())
    .addColumn("label", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createIndex("idx_favorites_user_kind_ref")
    .on("favorites")
    .columns(["user_id", "kind", "ref"])
    .unique()
    .execute();

  const hasBookmarks = await tableExists(db, "bookmarks");
  if (hasBookmarks) {
    // INSERT OR IGNORE rather than an upsert clause: this SQLite (bundled
    // with Bun 1.4) rejects `INSERT … SELECT … ON CONFLICT DO` outright —
    // upsert is only accepted after a VALUES source, verified by probe.
    // Bookmarks are unique per (user, path) anyway, so nothing is skipped.
    await sql`
      INSERT OR IGNORE INTO favorites (id, user_id, kind, ref, label, created_at)
      SELECT lower(hex(randomblob(16))), b.user_id, 'directory', b.path, b.name, b.created_at
      FROM bookmarks b
    `.execute(db);
    await db.schema.dropTable("bookmarks").execute();
  }
}

/** True when `name` is a table in this database. */
async function tableExists(db: Kysely<any>, name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * Best-effort rollback: directory favorites become bookmark rows again
 * (label → name, unlabeled ones fall back to the full path — SQLite has no
 * basename and no `reverse()`, and a recursive-CTE basename for a rollback
 * path is not worth it), the favorites table goes away. Other kinds have no
 * bookmarks-era meaning and are dropped with the table.
 */
export async function down(db: Kysely<any>): Promise<void> {
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
  await sql`
    INSERT INTO bookmarks (id, user_id, name, path, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), f.user_id, COALESCE(f.label, f.ref), f.ref, f.created_at, f.created_at
    FROM favorites f WHERE f.kind = 'directory'
  `.execute(db);
  await db.schema.dropTable("favorites").execute();
}
