import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("virtual_display_provider", "text", (col) => col.notNull().defaultTo("xvfb-x11vnc"))
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("virtual_display_provider").execute();
}
