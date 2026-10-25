import type { Kysely } from "kysely";

// Adds the per-node preview switch. Default 0 keeps the whole fleet (and the
// control-plane host) off after an upgrade: watching panes is opt-in per
// machine, and preview exposes terminal content, so an upgrade must never
// turn it on anywhere (0047's SSH-capability shape and doctrine).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("web_previews_enabled", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("nodes").addColumn("preview_enabled_at", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("preview_enabled_at").execute();
  await db.schema.alterTable("nodes").dropColumn("web_previews_enabled").execute();
}
