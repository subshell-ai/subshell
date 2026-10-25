import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("virtual_display_enabled", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  // Preserve the permission existing owners granted with the combined switch.
  await sql`update nodes set virtual_display_enabled = preview_enabled`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("virtual_display_enabled").execute();
}
