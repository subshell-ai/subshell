import type { Kysely } from "kysely";

/**
 * `name_locked`: 1 = the operator chose this session's name (by renaming it,
 * or pinning the title it had), so the reconcile sweep must stop mirroring
 * the harness's OSC pane title (`#{pane_title}`) into `name`. 0 — the default
 * — means auto-title mode: while the pane process is alive, the sweep adopts
 * whatever title the program inside publishes (Claude Code names its session
 * after the current task; harnesses that never set a title leave their pane
 * title equal to the running command, which the sweep treats as "no title").
 *
 * Existing rows default to 0, i.e. auto-title; names users cared about
 * survive a rename the moment they edit them, and the created-at default
 * names are exactly the kind this feature means to replace.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("name_locked", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").dropColumn("name_locked").execute();
}
