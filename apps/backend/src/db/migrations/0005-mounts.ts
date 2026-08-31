import { type Kysely, sql } from "kysely";

/**
 * Managed mounts: named, install-wide directories a session can run
 * against. Global scope (no user_id) — like settings, not profiles.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("mounts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("access", "text", (col) => col.notNull().defaultTo("rw"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema.createIndex("idx_mounts_name").on("mounts").column("name").unique().execute();
  await db.schema.createIndex("idx_mounts_path").on("mounts").column("path").unique().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("mounts").execute();
}
