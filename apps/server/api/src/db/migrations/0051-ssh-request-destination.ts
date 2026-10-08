import type { Kysely } from "kysely";

/**
 * The first-use request carries the FULL resolved destination (spec
 * 2026-10-08 §9, Task 12). The grant's selector is hostname-scoped (matched
 * against the resolved host at launch); the host-key PIN is keyed per
 * `user@host:port`, and the approval that creates the grant is also the
 * capture moment for that pin - which means the durable pending row must
 * outlive the asking launch with the exact destination the launch dialed, not
 * just its host. Nullable BY DESIGN: a pending row written before this
 * migration exists cannot be back-filled (the launch is gone), and the
 * approval path fails closed on null rather than guessing a port or a user.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("ssh_grant_requests").addColumn("destination", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("ssh_grant_requests").dropColumn("destination").execute();
}
