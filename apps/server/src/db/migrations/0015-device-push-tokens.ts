import type { Kysely } from "kysely";

/**
 * Native-device push tokens (spec 2026-08-31-mobile-native-app):
 *
 * - `device_tokens`: one row per enrolled phone/tablet, owned by a user.
 *   `token` is unique — an Expo push token IS the device's mailbox (OS
 *   restore / reinstall can hand it to a different account), so a
 *   re-enrollment replaces the row rather than duplicating or failing.
 * - `platform`: 'ios' | 'android' — recorded for ops/debugging only; the
 *   Expo relay routes by the token itself.
 * - `updated_at`: bumped on every (re-)enrollment; enrollment happens on
 *   every cold start, so token churn stays bounded.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("device_tokens")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("token", "text", (c) => c.notNull())
    .addColumn("platform", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_device_tokens_token").unique().on("device_tokens").column("token").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("device_tokens").execute();
}
