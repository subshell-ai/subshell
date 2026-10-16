import type { Kysely } from "kysely";

// SSH presets carry their owner's declared port forwards (spec 2026-10-15 §7):
// a JSON array of rows the protocol grammar validated AT SAVE, or NULL for
// "no forwards" (the pre-column spelling and the clear-the-list spelling
// agree). The rows are connection choices, not credentials, so they follow
// the same storage rules as destination and authentication - and a wide-bind
// row remains a WIDE refusal at launch until the connecting machine allows
// it, exactly as it would for a typed list.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("ssh_presets").addColumn("forwards", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("ssh_presets").dropColumn("forwards").execute();
}
