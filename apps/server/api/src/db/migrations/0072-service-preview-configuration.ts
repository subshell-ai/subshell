import type { Kysely } from "kysely";
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshell_services").addColumn("configuration", "text").execute();
  await db.schema
    .alterTable("subshell_services")
    .addColumn("revision", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshell_services").dropColumn("revision").execute();
  await db.schema.alterTable("subshell_services").dropColumn("configuration").execute();
}
