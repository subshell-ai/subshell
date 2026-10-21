import type { Kysely } from "kysely";

/** Store discovery guidance independently of launch defaults and directory permissions. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("presets").addColumn("cross_comm_notes", "text").execute();
  await db.schema.alterTable("nodes").addColumn("cross_comm_notes", "text").execute();
  await db.schema.alterTable("nodes").addColumn("recommended_starting_dirs", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("recommended_starting_dirs").execute();
  await db.schema.alterTable("nodes").dropColumn("cross_comm_notes").execute();
  await db.schema.alterTable("presets").dropColumn("cross_comm_notes").execute();
}
