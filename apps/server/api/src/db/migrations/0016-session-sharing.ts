import type { Kysely } from "kysely";

/**
 * Session sharing + notification defaults (spec 2026-08-31):
 *
 * - `user_meta.notify_enabled`: per-user notification master switch, default 1
 *   (on). A push fires only when this AND the session's `notify` bell are on;
 *   off means total silence regardless of any bells.
 * - `session_shares`: per-session access grants. `grantee_user_id` NULL is the
 *   "Everyone" grant (applies to all signed-in users); otherwise it names one
 *   user. `permission` is "view" or "edit". Cascade-deletes with its session.
 *   Uniqueness of the (session, grantee) pair — including a single Everyone
 *   row — is enforced by the repository's transactional replace, because
 *   SQLite unique indexes treat NULLs as distinct.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("user_meta")
    .addColumn("notify_enabled", "integer", (c) => c.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createTable("session_shares")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("session_id", "text", (c) => c.notNull().references("sessions.id").onDelete("cascade"))
    .addColumn("grantee_user_id", "text")
    .addColumn("permission", "text", (c) => c.notNull())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_session_shares_session").on("session_shares").column("session_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("session_shares").execute();
  await db.schema.alterTable("user_meta").dropColumn("notify_enabled").execute();
}
