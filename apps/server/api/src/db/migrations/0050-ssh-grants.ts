import type { Kysely } from "kysely";

/**
 * The grant tier (spec 2026-10-08 §6, §9): the three tables the authorization
 * layer stands on.
 *
 * - `ssh_key_grants`: the standing authorization - one owner's permission to
 *   reach destinations matching a selector by signing with the agent on one
 *   key-home machine. It carries the operator's fingerprint SELECTION (public
 *   `SHA256:` identifiers as a JSON array, capped at
 *   `SSH_MAX_GRANT_FINGERPRINTS` by the service, never by a silent truncation)
 *   and nothing else about the keys: no key material, ever (§6.1).
 * - `ssh_grant_requests`: the DURABLE first-use queue (spec §6.2, borrowing
 *   the signup pending-approvals shape): the pending row survives a plane
 *   restart so a re-launch finds it, and the expiry sweep marks stale rows
 *   `expired` without writing any audit event.
 * - `ssh_host_pins`: the M2 TOFU host-key store (§9), keyed by the RESOLVED
 *   destination, one pin per `user@host:port` per owner, independent of
 *   grants. The read/write/capture LOGIC lands with T12; the schema ships
 *   here per the plan's file map so later migrations never re-cut it.
 *
 * Owner is FK-cascaded like the saved-hosts ledger (0048): a removed account
 * takes its grants, requests, and pins with it. Node ids carry no FK -
 * matching a grant against a vanished node is refused at the gate, not at the
 * schema, the same posture `ssh_saved_hosts.node_id` set.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("ssh_key_grants")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("owner_user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("key_home_node_id", "text", (col) => col.notNull())
    .addColumn("resolved_selector", "text", (col) => col.notNull())
    .addColumn("fingerprints", "text", (col) => col.notNull())
    .addColumn("created_via", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();
  // The launch-time match reads one owner's grants for one key home; the list
  // screen reads one owner's grants. Both ride this index.
  await db.schema
    .createIndex("idx_ssh_key_grants_owner_keyhome")
    .on("ssh_key_grants")
    .columns(["owner_user_id", "key_home_node_id"])
    .execute();

  await db.schema
    .createTable("ssh_grant_requests")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("owner_user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("key_home_node_id", "text", (col) => col.notNull())
    .addColumn("resolved_selector", "text", (col) => col.notNull())
    .addColumn("requested_fingerprints", "text")
    .addColumn("pane_id", "text", (col) => col.notNull())
    .addColumn("b_node_id", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
  // The approvals screen reads one owner's OPEN (pending) queue; the dedup
  // read at request time is (owner, key home, selector) newest-first.
  await db.schema
    .createIndex("idx_ssh_grant_requests_owner_status")
    .on("ssh_grant_requests")
    .columns(["owner_user_id", "status"])
    .execute();

  await db.schema
    .createTable("ssh_host_pins")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("owner_user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("destination", "text", (col) => col.notNull())
    .addColumn("host_key", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();
  // One pin per owner per resolved destination (§9): the TOFU record, so a
  // second capture at a differing key is the §9 hard block, not a second row.
  await db.schema
    .createIndex("idx_ssh_host_pins_owner_destination")
    .unique()
    .on("ssh_host_pins")
    .columns(["owner_user_id", "destination"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ssh_host_pins").execute();
  await db.schema.dropTable("ssh_grant_requests").execute();
  await db.schema.dropTable("ssh_key_grants").execute();
}
