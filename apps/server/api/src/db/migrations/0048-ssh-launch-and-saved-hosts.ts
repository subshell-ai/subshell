import type { Kysely } from "kysely";

/**
 * The SSH launcher tier (spec 2026-10-07 §7): `ssh_saved_hosts`, the per-owner
 * destination ledger, and `subshells.ssh`, the pane's approved snapshot.
 *
 * The ledger is keyed by the RESOLVED canonical destination (the spelling
 * `sshCanonicalDestination` in the db-types file produces), never by the
 * alias, so an edited alias cannot silently re-point a saved row.
 * `subshells.ssh` is NULL for
 * every pane that is not an SSH terminal, which is exactly what the
 * owner-only-input rule reads: the value's presence is the trigger.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ssh_saved_hosts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("owner_user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("destination", "text", (col) => col.notNull())
    .addColumn("alias", "text")
    .addColumn("node_id", "text", (col) => col.notNull())
    .addColumn("saved_at", "text")
    .addColumn("last_connect_at", "text", (col) => col.notNull())
    .execute();
  // The key: one row per owner per canonical destination. An insert that
  // arrives at a standing key is the service's refresh, not a second entry.
  await db.schema
    .createIndex("idx_ssh_saved_hosts_owner_destination")
    .unique()
    .on("ssh_saved_hosts")
    .columns(["owner_user_id", "destination"])
    .execute();
  // The list read is one owner's recents, newest first: the recency column is
  // `last_connect_at`, refreshed on every launch, DESC spelled in the index.
  await db.schema
    .createIndex("idx_ssh_saved_hosts_owner_recent")
    .on("ssh_saved_hosts")
    .columns(["owner_user_id", "last_connect_at desc"])
    .execute();
  await db.schema.alterTable("subshells").addColumn("ssh", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("ssh").execute();
  await db.schema.dropTable("ssh_saved_hosts").execute();
}
