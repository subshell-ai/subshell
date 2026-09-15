import type { Kysely } from "kysely";

/**
 * Node maintenance (spec 2026-09-14): one flag per node answering WHETHER
 * anyone may launch there, beside the shares that answer WHO.
 *
 * `maintenance` is `0` by default, and that default is the whole upgrade
 * story: every node already enrolled keeps accepting subshells the moment
 * this runs. Inverting it — treating an unwritten column as "in maintenance"
 * — would take the entire fleet out of service on a restart nobody asked
 * anything of, which is the same argument 0030 makes for `user_meta.disabled`
 * defaulting to enabled.
 *
 * `maintenance_at` is the reconciliation protocol, not a display string: the
 * plane and the machine each hold a copy of this state, either may be written
 * while the other is unreachable, and on reconnect the NEWER stamp wins.
 * `maintenance_source` records which end wrote the value that stands
 * (`'plane' | 'node'`), so the UI can say where a window came from.
 *
 * **This migration adds columns and nothing else.** In particular it does NOT
 * read `local`'s missing Everyone/`edit` share row as a pre-existing
 * maintenance window. That row means "nobody is GRANTED launch access here",
 * which is a different sentence from "this machine is out of service", and an
 * admin who narrowed the host to named people would find it in maintenance on
 * upgrade — with the count of subshells that reading would then stop. The two
 * axes compose by AND from here on; neither is derived from the other.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("nodes")
    .addColumn("maintenance", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("nodes").addColumn("maintenance_at", "text").execute();
  await db.schema.alterTable("nodes").addColumn("maintenance_source", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("nodes").dropColumn("maintenance_source").execute();
  await db.schema.alterTable("nodes").dropColumn("maintenance_at").execute();
  await db.schema.alterTable("nodes").dropColumn("maintenance").execute();
}
