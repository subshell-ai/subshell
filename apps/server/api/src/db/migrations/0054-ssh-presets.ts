import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Fresh app migrations precede better-auth's user table. There cannot be
  // ledger rows yet, and even an empty DELETE resolves its foreign key.
  const saved = await sql<{
    count: number;
  }>`SELECT count(*) AS count FROM ssh_saved_hosts WHERE saved_at IS NOT NULL`.execute(db);
  if (saved.rows[0].count > 0) await sql`DELETE FROM ssh_saved_hosts WHERE saved_at IS NOT NULL`.execute(db);
  await db.schema.alterTable("ssh_saved_hosts").dropColumn("saved_at").execute();
  await db.schema.alterTable("ssh_saved_hosts").renameTo("ssh_recent_destinations").execute();
  await db.schema
    .createTable("ssh_presets")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("description", "text")
    .addColumn("node_id", "text", (c) => c.references("nodes.id").onDelete("set null"))
    .addColumn("destination", "text", (c) => c.notNull())
    .addColumn("alias", "text")
    .addColumn("resolution_alias", "text")
    .addColumn("authentication", "text", (c) => c.notNull())
    .addColumn("key_home", "text", (c) => c.references("nodes.id").onDelete("set null"))
    .addColumn("fingerprints", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await sql`CREATE UNIQUE INDEX idx_ssh_presets_owner_name ON ssh_presets(user_id, name COLLATE NOCASE)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // DESTRUCTIVE both directions, deliberately (the 0029 drafts precedent):
  // up() discarded the saved_at rows, and down() drops every SSH preset this
  // schema added. The pre-0054 schema cannot express a named preset, so a
  // rollback restores the shape, never the data.
  await db.schema.dropTable("ssh_presets").execute();
  await db.schema.alterTable("ssh_recent_destinations").renameTo("ssh_saved_hosts").execute();
  await db.schema.alterTable("ssh_saved_hosts").addColumn("saved_at", "text").execute();
}
