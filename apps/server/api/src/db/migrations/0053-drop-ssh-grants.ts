import type { Kysely } from "kysely";

/** SSH uses existing machine launch access; keep destination trust and history. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ssh_grant_requests").execute();
  await db.schema.dropTable("ssh_key_grants").execute();
}

/** Dropped authorizations cannot be reconstructed safely. */
export async function down(): Promise<void> {
  throw new Error("SSH grant removal is irreversible; restore a backup to downgrade");
}
