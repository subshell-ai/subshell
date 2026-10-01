import type { Kysely } from "kysely";

/** A recovery key may replace one existing node, never create a different one. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("node_setup_keys")
    .addColumn("target_node_id", "text", (col) => col.references("nodes.id").onDelete("cascade"))
    .execute();
  await db.schema.alterTable("node_setup_keys").addColumn("target_api_key_id", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("node_setup_keys").dropColumn("target_api_key_id").execute();
  await db.schema.alterTable("node_setup_keys").dropColumn("target_node_id").execute();
}
