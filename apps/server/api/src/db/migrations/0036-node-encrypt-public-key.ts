import type { Kysely } from "kysely";

/**
 * `nodes.encryptPublicKey` — the node's static X25519 public half for the
 * /ws/node link encryption (spec 2026-09-24 §3). NULL is the whole migration
 * story: every node enrolled before this column exists reads NULL, which is
 * precisely "legacy mode — held-updatable until it registers" (§5). No
 * backfill and no default: a wrong key here is a pinned-identity break, not
 * a missing preference.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").addColumn("encryptPublicKey", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("encryptPublicKey").execute();
}
