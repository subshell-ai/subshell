import { type Kysely, sql } from "kysely";

/** Separate foreign keys keep grants tied to the lifetime of each preset kind. */
export async function up(db: Kysely<any>): Promise<void> {
  for (const [table, parent] of [
    ["preset_shares", "presets"],
    ["ssh_preset_shares", "ssh_presets"],
  ] as const) {
    await db.schema
      .createTable(table)
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("preset_id", "text", (c) => c.notNull().references(`${parent}.id`).onDelete("cascade"))
      .addColumn("grantee_user_id", "text", (c) => c.references("user.id").onDelete("cascade"))
      .addColumn("permission", "text", (c) => c.notNull().check(sql`permission IN ('view', 'edit')`))
      .addColumn("created_by", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex(`idx_${table}_preset`).on(table).column("preset_id").execute();
    await db.schema.createIndex(`idx_${table}_grantee`).on(table).column("grantee_user_id").execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ssh_preset_shares").execute();
  await db.schema.dropTable("preset_shares").execute();
}
