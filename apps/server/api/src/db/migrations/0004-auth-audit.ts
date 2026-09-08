import type { Kysely } from "kysely";

// Kysely<any> matches the Migration interface shape and mirrors 0003's
// signature so typed `Kysely<Database>` instances can run migrations.
export async function up(db: Kysely<any>): Promise<void> {
  // Failed sign-in tracking for the exponential-backoff rate limiter.
  // last_attempt_at is nullable so the row can exist with count=0 and no
  // attempt window recorded yet.
  await db.schema
    .createTable("auth_attempts")
    .addColumn("email", "text", (col) => col.primaryKey())
    .addColumn("attempt_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_attempt_at", "text")
    .execute();

  // Admin-visible audit trail (queries land in Task 10).
  await db.schema
    .createTable("audit_events")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("actor_user_id", "text")
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("target_type", "text")
    .addColumn("target_id", "text")
    .addColumn("metadata_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("audit_events").execute();
  await db.schema.dropTable("auth_attempts").execute();
}
