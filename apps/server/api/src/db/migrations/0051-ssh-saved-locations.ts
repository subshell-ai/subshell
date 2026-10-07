import type { Kysely } from "kysely";

/** Personal bookmarks contain destination facts and folders, never SSH credentials. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ssh_saved_locations")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("origin_kind", "text", (c) => c.notNull())
    .addColumn("origin_id", "text", (c) => c.notNull())
    .addColumn("alias", "text", (c) => c.notNull())
    .addColumn("host", "text", (c) => c.notNull())
    .addColumn("port", "integer", (c) => c.notNull())
    .addColumn("user", "text")
    .addColumn("path", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("ssh_saved_locations_owner").on("ssh_saved_locations").column("owner_user_id").execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ssh_saved_locations").execute();
}
