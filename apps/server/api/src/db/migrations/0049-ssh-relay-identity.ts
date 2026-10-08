import type { Kysely } from "kysely";

/**
 * The relay identity tier (spec 2026-10-08 §4.2, §4.5, §9).
 *
 * `identities.signing_public_key` is the per-machine ES256 signing slot that
 * rides beside the ECDH-ES encryption key in the SAME `node:` record: enroll
 * fills it, deletion cascades it exactly as the encryption key already does.
 * `nodes.ssh_fingerprint` is the durable mirror of the last runtime-report
 * ssh-fingerprint block, so the trust card survives an offline node or a
 * plane restart; it is populated by the report-handling task, not this one.
 *
 * Both columns are NULL for every pre-M2 row: the signing slot is filled by a
 * re-enroll or the `ssh_register_identity` bootstrap (§4.3), and the mirror by
 * the next runtime report (§4.5). An upgrade therefore changes nothing any
 * existing behavior reads.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("identities").addColumn("signing_public_key", "text").execute();
  await db.schema.alterTable("nodes").addColumn("ssh_fingerprint", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("ssh_fingerprint").execute();
  await db.schema.alterTable("identities").dropColumn("signing_public_key").execute();
}
