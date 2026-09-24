import type { Kysely } from "kysely";

/**
 * One notification per unseen interval (spec 2026-09-23).
 *
 * `last_push_urgency` is the urgency of the last DELIVERED push attempt this
 * pane made that its owner has not answered by opening the pane: NULL =
 * nothing unseen. The urgency ladder itself lives beside the gate in
 * `services/notify.service.ts` (only notify.service and the clear sites
 * interpret the number); this column stores it. Nothing here backfills — a
 * row created before the column exists has, correctly, never pushed under
 * the new rule.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").addColumn("last_push_urgency", "integer").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("last_push_urgency").execute();
}
