import type { Kysely } from "kysely";

/**
 * Per-user terminal history cap (spec 2026-09-03 close-vocabulary design):
 *
 * - `user_meta.terminal_replay_lines`: how many trailing lines a terminal
 *   replays when this user attaches, before switching to the live tail.
 *   NULL = instance default (`SUBSHELL_TERMINAL_REPLAY_LINES`, 100). This
 *   replaces the per-subshell cap (0018's column, now on `subshells`), whose
 *   UI and write path are removed — that column stays (read by nothing) so a
 *   rollback can still find its data. Readers clamp to [1, 200].
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user_meta").addColumn("terminal_replay_lines", "integer").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user_meta").dropColumn("terminal_replay_lines").execute();
}
