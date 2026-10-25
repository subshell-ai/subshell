import { type Kysely, sql } from "kysely";
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("virtual_display_providers", "text", (c) => c.notNull().defaultTo('["xvfb-x11vnc"]'))
    .execute();
  await db.schema.alterTable("presets").addColumn("screen_config", "text").execute();
  // Before provider overrides existed, every allocated display used Xvfb.
  await sql`UPDATE subshells SET screen_config = json_set(screen_config, '$.provider', 'xvfb-x11vnc') WHERE screen_config IS NOT NULL AND json_valid(screen_config) AND json_extract(screen_config, '$.provider') IS NULL`.execute(
    db,
  );
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("presets").dropColumn("screen_config").execute();
  await db.schema.alterTable("nodes").dropColumn("virtual_display_providers").execute();
}
