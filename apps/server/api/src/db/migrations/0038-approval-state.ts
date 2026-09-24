import type { Kysely } from "kysely";

/**
 * `user_meta.approval_state` + `pending_arrived_at` (spec 2026-09-24 §6).
 *
 * DEFAULT 'approved' is the whole upgrade story: every account that exists
 * predates approval, and an absent meta row reads approved the same way an
 * absent row reads enabled for `disabled` (0030). `pending_arrived_at` is
 * stamped when a row lands in `pending` and re-stamped on every repeat knock
 * (dedup, §6) — it is what the expiry sweep compares against.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("userMeta")
    .addColumn("approvalState", "text", (c) => c.notNull().defaultTo("approved"))
    .execute();
  await db.schema.alterTable("userMeta").addColumn("pendingArrivedAt", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("userMeta").dropColumn("pendingArrivedAt").execute();
  await db.schema.alterTable("userMeta").dropColumn("approvalState").execute();
}
