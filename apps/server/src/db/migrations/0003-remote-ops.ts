import type { Kysely } from "kysely";

// Kysely<any> matches the Migration interface shape and mirror 0002's
// signature so typed `Kysely<Database>` instances can run migrations.
export async function up(db: Kysely<any>): Promise<void> {
  // Liveness + auto-restart columns on sessions.
  await db.schema
    .alterTable("sessions")
    .addColumn("alive", "integer", (c) => c.defaultTo(1))
    .execute();
  await db.schema.alterTable("sessions").addColumn("exit_code", "integer").execute();
  await db.schema.alterTable("sessions").addColumn("started_at", "text").execute();
  await db.schema
    .alterTable("sessions")
    .addColumn("backoff_count", "integer", (c) => c.defaultTo(0))
    .execute();
  await db.schema.alterTable("sessions").addColumn("next_restart_at", "text").execute();
  await db.schema
    .alterTable("sessions")
    .addColumn("restart_on_exit", "integer", (c) => c.defaultTo(0))
    .execute();
  // Per-profile default for new sessions.
  await db.schema
    .alterTable("profiles")
    .addColumn("restart_on_exit", "integer", (c) => c.defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const col of ["alive", "exit_code", "started_at", "backoff_count", "next_restart_at", "restart_on_exit"]) {
    await db.schema.alterTable("sessions").dropColumn(col).execute();
  }
  await db.schema.alterTable("profiles").dropColumn("restart_on_exit").execute();
}
