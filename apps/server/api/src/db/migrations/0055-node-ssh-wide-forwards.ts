import type { Kysely } from "kysely";

// Adds the per-node wide-bind allowance for SSH port forwards
// (docs/superpowers/specs/2026-10-15-ssh-port-forwards-design.md §6). Default
// 0 keeps the whole fleet loopback-only after an upgrade: a forward that binds
// a non-loopback address turns the machine into a router for whatever network
// reaches that port, and only the machine's owner decides that is acceptable
// there. Same default-0 doctrine as the SSH capability gate (0047).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("ssh_wide_forwards", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("ssh_wide_forwards").execute();
}
