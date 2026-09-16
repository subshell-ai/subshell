import type { Kysely } from "kysely";

/**
 * The first-run wizard's resume bookmark (spec 2026-09-16): one nullable text
 * column on `user_meta` holding `network`, `agent`, `launch` — or NULL.
 *
 * NULL is the default and it is the whole upgrade story: every existing
 * account keeps landing on the dashboard, which is what they do today. The
 * inverse — an unwritten column reading as "mid-wizard" — would put every user
 * of an upgraded instance back into first run, the same argument 0030 and 0031
 * make for their own defaults.
 *
 * It is per USER rather than instance-wide because the wizard is the first
 * admin's and nobody else's: `promoteFirstUserAtomically` writes `'network'`
 * for the account it makes admin and NULL for every later one, in the same
 * statement, so the two facts cannot disagree.
 *
 * No index: it is read by primary key (`WHERE user_id = ?`) and never scanned.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user_meta").addColumn("setup_step", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user_meta").dropColumn("setup_step").execute();
}
