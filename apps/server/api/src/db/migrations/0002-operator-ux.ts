import type { Kysely } from "kysely";

/**
 * Operator UX: tracks per-session operator notes and the last time the
 * session log received output (drives the active/idle heuristic).
 */
export async function up(db: Kysely<any>): Promise<void> {
  // SQLite supports ALTER TABLE ADD COLUMN; defaultTo(null) makes existing rows valid.
  await db.schema
    .alterTable("sessions")
    .addColumn("last_output_at", "text", (col) => col.defaultTo(null))
    .execute();
  await db.schema
    .alterTable("sessions")
    .addColumn("notes", "text", (col) => col.defaultTo(null))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").dropColumn("last_output_at").execute();
  await db.schema.alterTable("sessions").dropColumn("notes").execute();
}
