import type { Kysely } from "kysely";

/**
 * Session notifications (spec 2026-08-30-harness-notifications):
 *
 * - `sessions.notify`: 1 = push the owner when this session finishes a turn,
 *   needs approval, or exits. Default 0 — silent unless the operator rings
 *   the bell — including rows created before this migration.
 * - `sessions.waiting_since`: ISO timestamp of the attention event that put
 *   the session in "waiting for you" state (null = not waiting). Set by the
 *   harness hook / idle watcher, cleared when output resumes or the pane dies.
 * - `notifications_subscriptions`: one row per browser push subscription,
 *   owned by a user. `endpoint` is unique: a re-authorized browser replaces
 *   its own row (the endpoint string is the browser's identity here).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("notify", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("sessions").addColumn("waiting_since", "text").execute();
  await db.schema
    .createTable("notifications_subscriptions")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("endpoint", "text", (c) => c.notNull())
    .addColumn("p256dh", "text", (c) => c.notNull())
    .addColumn("auth", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("idx_notifications_subscriptions_endpoint")
    .unique()
    .on("notifications_subscriptions")
    .column("endpoint")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("notifications_subscriptions").execute();
  await db.schema.alterTable("sessions").dropColumn("waiting_since").execute();
  await db.schema.alterTable("sessions").dropColumn("notify").execute();
}
