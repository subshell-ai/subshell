import type { Kysely } from "kysely";

/** Retain spawn provenance without changing launch access or the lifetime of child subshells. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("subshells")
    .addColumn("parent_subshell_id", "text", (column) => column.references("subshells.id").onDelete("set null"))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("parent_subshell_id").execute();
}
