import type { Kysely } from "kysely";

/**
 * An admin may disable a user account (`user_meta.disabled`).
 *
 * A disabled account cannot authenticate at all: better-auth refuses to mint
 * a session for it (so neither password nor passkey sign-in works), and
 * `authGuard` treats it as unauthenticated on the bearer path too, so tokens
 * a still-running subshell holds stop working the moment the flag is set.
 *
 * `0` (enabled) is both the column default and the absent-row reading: a user
 * minted before this column existed, or one whose `user_meta` row was never
 * created, is enabled. Inverting that anywhere would lock every existing
 * account out on upgrade.
 *
 * It lives on `user_meta` rather than on better-auth's `user` table for the
 * same reason `role` does: better-auth owns its own schema, and the app's
 * policy fields stay out of it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("user_meta")
    .addColumn("disabled", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user_meta").dropColumn("disabled").execute();
}
