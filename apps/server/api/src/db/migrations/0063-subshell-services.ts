import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("subshell_services")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("subshell_id", "text", (c) => c.notNull().references("subshells.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("host", "text", (c) => c.notNull())
    .addColumn("port", "integer", (c) => c.notNull())
    .addColumn("protocol", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addUniqueConstraint("subshell_services_target", ["subshell_id", "host", "port", "protocol"])
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("subshell_services").execute();
}
