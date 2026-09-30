import type { Kysely } from "kysely";

/**
 * The preset gains a launch dimension (spec 2026-09-29 preset-launch-fields):
 * an optional node, working directory, and prompt block stack, so "start the
 * usual thing" is one stored choice instead of a prior subshell to copy from -
 * the "Copy settings from a subshell" picker died with this migration's
 * feature. All three are NULL-able: a preset stays a settings bundle for
 * people who never set them, and a preset with all three filled is what the
 * MCP surface calls cross-comm ready (derived from the columns, never stored).
 *
 * `node_id` uses ON DELETE SET NULL, not CASCADE: the node dying unsets a
 * launch hint, it does not destroy the customisation saved next to it. The
 * unset drops the preset out of cross-comm readiness visibly rather than
 * leaving a row that must fail at launch.
 *
 * `prompt_blocks` is the JSON array of the launch form's block stack minus its
 * form-local ids; bodies are snapshots taken at pick time, so editing or
 * deleting a library prompt never changes what a preset launches.
 *
 * (The old 0027 note - "a preset never names a node" - described the pin that
 * spec 2026-09-13 §2.3 killed. This migration does not resurrect the pin: the
 * launch still resolves a node when no preset names one, and a request may
 * still override what a preset names. The row just gets a place to say where.)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("presets")
    .addColumn("node_id", "text", (col) => col.references("nodes.id").onDelete("set null"))
    .execute();
  await db.schema.alterTable("presets").addColumn("working_dir", "text").execute();
  await db.schema.alterTable("presets").addColumn("prompt_blocks", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const col of ["prompt_blocks", "working_dir", "node_id"] as const) {
    await db.schema.alterTable("presets").dropColumn(col).execute();
  }
}
