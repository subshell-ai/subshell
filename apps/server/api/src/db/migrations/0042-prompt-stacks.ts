import { type Kysely, sql } from "kysely";

/**
 * `prompt_stacks` + `prompt_stack_items` (spec 2026-09-29): ordered collections
 * of saved prompts. The stack row mirrors a prompt row's ownership exactly -
 * a per-user `shared` 0/1 column is the whole sharing rule.
 *
 * The items table IS the feature's delete rule: `prompt_id` carries an ON DELETE
 * CASCADE to `prompts`, so deleting a prompt removes it from every stack the
 * database knows about, and the stack can lawfully end up empty (a state the
 * page surfaces, not a row to repair). `ordinal` is the launch order. An item is
 * exactly one of: a live reference (`prompt_id` set - edits show through) or the
 * stack's own inline free-text row (`body` set, `description` is its label); the
 * CHECK refuses both or neither. Unsharing a referenced prompt is NOT a row
 * change: the read view drops members the caller cannot see, so the member
 * returns to the stack if sharing ever comes back.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("prompt_stacks")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("label", "text", (col) => col.notNull())
    .addColumn("shared", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  // The two list reads ride it: own (user_id) and shared-with-me
  // (shared = 1, other owners) — the prompts index, same shape.
  await db.schema
    .createIndex("idx_prompt_stacks_user_shared")
    .on("prompt_stacks")
    .columns(["user_id", "shared"])
    .execute();

  await db.schema
    .createTable("prompt_stack_items")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("stack_id", "text", (col) => col.notNull().references("prompt_stacks.id").onDelete("cascade"))
    .addColumn("ordinal", "integer", (col) => col.notNull())
    // The delete rule, in a line: the prompt dies, the member row follows.
    .addColumn("prompt_id", "text", (col) => col.references("prompts.id").onDelete("cascade"))
    .addColumn("body", "text")
    .addColumn("description", "text")
    .addCheckConstraint("prompt_stack_items_one_member", sql`(("prompt_id" IS NOT NULL) + ("body" IS NOT NULL)) = 1`)
    .addUniqueConstraint("prompt_stack_items_stack_ordinal", ["stack_id", "ordinal"])
    .execute();
  // FK-cascade support: when a prompt is deleted, SQLite finds THIS table's
  // child rows through this index (the empty-stack rule, run by the engine on
  // every prompts delete). The page's "which stacks hold this prompt"
  // cross-links are the client's derivation over the list payload and issue
  // NO query here; this index is not theirs.
  await db.schema.createIndex("idx_prompt_stack_items_prompt").on("prompt_stack_items").column("prompt_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("prompt_stack_items").execute();
  await db.schema.dropTable("prompt_stacks").execute();
}
