import type { Kysely } from "kysely";

/** Keep the last host-capacity report available while a node is offline. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("system_specs", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("system_specs").execute();
}
