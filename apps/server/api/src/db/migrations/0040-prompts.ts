import { type Kysely, sql } from "kysely";

/**
 * `prompts`: a saved-prompt library (spec 2026-09-28). Description + body,
 * owned per user, `shared` 1 = readable by every account on the instance.
 * The everyone-or-none flag is a COLUMN, not a shares table: that is the
 * whole rule today, and the API's `shared` field survives a future swap to
 * real grant rows. No uniqueness on description (two prompts may share one).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("prompts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("description", "text", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("shared", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  // The two list reads ride it: own (user_id) and shared-with-me
  // (shared = 1, other owners).
  await db.schema.createIndex("idx_prompts_user_shared").on("prompts").columns(["user_id", "shared"]).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("prompts").execute();
}
