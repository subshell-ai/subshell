import { type Kysely, sql } from "kysely";

/**
 * Cross-session channels: an append-only encrypted post log with per-channel
 * sequences, membership as public-key registration (sealed delivery),
 * per-principal read cursors, and the session→api-key link used to revoke
 * a session's token when the session dies.
 *
 * `envelope` is a jose General JWE JSON string; the server never parses it.
 * The recipient list is denormalized into channel_post_recipients so reads
 * can filter (portably, via join) to posts the caller can decrypt.
 *
 * Principal columns (`created_by`, `author`, `principal_id`, `added_by`) are
 * free-form labels ("sess:<id>", "user:<id>", future "peer:<instance>:<id>")
 * — never foreign keys — so federation never has to rewrite history.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("channels")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createTable("identities")
    .addColumn("principal_id", "text", (col) => col.primaryKey())
    .addColumn("public_key", "text", (col) => col.notNull())
    .addColumn("display_name", "text")
    .addColumn("registered_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema
    .createTable("channel_members")
    .addColumn("channel_id", "text", (col) => col.notNull().references("channels.id").onDelete("cascade"))
    .addColumn("principal_id", "text", (col) => col.notNull())
    .addColumn("added_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("added_by", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("idx_channel_members_pk")
    .on("channel_members")
    .columns(["channel_id", "principal_id"])
    .unique()
    .execute();

  await db.schema
    .createTable("channel_posts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("channel_id", "text", (col) => col.notNull().references("channels.id").onDelete("cascade"))
    .addColumn("seq", "integer", (col) => col.notNull())
    .addColumn("author", "text", (col) => col.notNull())
    .addColumn("envelope", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  await db.schema
    .createIndex("idx_channel_posts_cursor")
    .on("channel_posts")
    .columns(["channel_id", "seq"])
    .unique()
    .execute();

  await db.schema
    .createTable("channel_post_recipients")
    .addColumn("post_id", "text", (col) => col.notNull().references("channel_posts.id").onDelete("cascade"))
    .addColumn("principal_id", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("idx_cpr_lookup")
    .on("channel_post_recipients")
    .columns(["principal_id", "post_id"])
    .execute();

  await db.schema
    .createTable("channel_cursors")
    .addColumn("channel_id", "text", (col) => col.notNull().references("channels.id").onDelete("cascade"))
    .addColumn("principal_id", "text", (col) => col.notNull())
    .addColumn("last_seq", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .createIndex("idx_cursors_pk")
    .on("channel_cursors")
    .columns(["channel_id", "principal_id"])
    .unique()
    .execute();

  // The plugin key backing each session's token; revoked when the session dies.
  await db.schema.alterTable("sessions").addColumn("api_key_id", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [
    "channel_cursors",
    "channel_post_recipients",
    "channel_posts",
    "channel_members",
    "identities",
    "channels",
  ]) {
    await db.schema.dropTable(t).execute();
  }
  await db.schema.alterTable("sessions").dropColumn("api_key_id").execute();
}
