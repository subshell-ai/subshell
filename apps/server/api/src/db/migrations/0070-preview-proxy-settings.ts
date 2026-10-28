import type { Kysely } from "kysely";
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("preview_proxy_settings")
    .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
    .addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
    .addColumn("host", "text", (c) => c.notNull())
    .addColumn("protocol", "text", (c) => c.notNull())
    .addColumn("port", "integer", (c) => c.notNull())
    .addColumn("rewrite_urls", "integer", (c) => c.notNull())
    .addColumn("pass_host", "integer", (c) => c.notNull())
    .addColumn("rewrite_redirects", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("preview_proxy_settings_target", ["user_id", "node_id", "host", "protocol", "port"])
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("preview_proxy_settings").execute();
}
