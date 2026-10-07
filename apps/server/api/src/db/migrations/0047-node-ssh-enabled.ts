import type { Kysely } from "kysely";

// Adds the per-node SSH capability gate. Default 0 keeps the whole fleet (and
// the control-plane host) off after an upgrade: SSH egress and key use are
// opt-in per machine (spec 4.3; the maintenance default-0 "upgrade keeps the
// fleet as it was" doctrine).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("ssh_enabled", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("nodes").addColumn("ssh_enabled_at", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("ssh_enabled_at").execute();
  await db.schema.alterTable("nodes").dropColumn("ssh_enabled").execute();
}
