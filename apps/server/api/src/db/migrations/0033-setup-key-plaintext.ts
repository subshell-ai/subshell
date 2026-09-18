import type { Kysely } from "kysely";

/**
 * Setup keys are stored as the key itself, and there is no `label`.
 *
 * Two decisions from the node-setup revamp (2026-09-17) land in one table:
 *
 * - **`label` is gone.** The Add-node dialog no longer asks for a name — a node names
 *   itself on the machine that becomes it (`subshell setup` asks, `--name` answers for a
 *   script), because that is where the hostname lives and where the operator knows what
 *   the box is. A label with no name behind it had one job left: naming a row nobody can
 *   connect to a node. The key IS the row now, so it is shown in the list.
 * - **`key_hash` becomes `key`.** Showing a key on the Setup keys page means the server
 *   can render it, and a SHA-256 digest cannot be un-digested. So the plaintext is the
 *   stored form and the one lookup index sits on it.
 *
 * The exposure this accepts is real and bounded: a credential that enrolls ONE machine,
 * works once, and stops working entirely after 24 h (or when revoked), sitting in a
 * 0600 database the same operator already reads to mint new ones. `used_at` and
 * `expires_at` decide the rest — a spent or expired key is as inert as a digest. The
 * accounting is `docs/security.md`, "Setup keys are stored in plaintext".
 *
 * **Both directions drop the table, so every outstanding key is gone after this runs** —
 * including one an operator is mid-`curl | bash` with, and the `label` of a used key
 * cannot come back in `down` (there is no restoring a digest either). That is the
 * accepted cost rather than an oversight: these rows are ≤24 h credentials, every act on
 * them is already in the audit log, and an instance that cares can re-open the dialog.
 * Rebuilding the table (rather than ADD/DROP COLUMN) is also what keeps `key` NOT NULL
 * without a `DEFAULT ''` that a future insert could silently satisfy.
 *
 * Nothing references this table, so the rebuild takes no foreign-key dance.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("node_setup_keys").execute();
  await db.schema
    .createTable("node_setup_keys")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("used_at", "text")
    .addColumn("consumed_node_id", "text")
    .execute();
  // Redemption looks a key up by its own text now, so this index is the same lookup it
  // always indexed — UNIQUE additionally pins an honest duplicate, which the digest
  // index used to buy.
  await db.schema.createIndex("node_setup_keys_key_idx").on("node_setup_keys").column("key").unique().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("node_setup_keys").execute();
  await db.schema
    .createTable("node_setup_keys")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("key_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("used_at", "text")
    .addColumn("consumed_node_id", "text")
    .execute();
  await db.schema
    .createIndex("node_setup_keys_key_hash_idx")
    .on("node_setup_keys")
    .column("key_hash")
    .unique()
    .execute();
}
