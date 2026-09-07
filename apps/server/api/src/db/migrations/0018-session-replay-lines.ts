import type { Kysely } from "kysely";

/**
 * Per-session terminal history cap (2026-09-01):
 *
 * - `sessions.terminal_replay_lines`: how many trailing lines of the session
 *   log the terminal WS replays when someone attaches, before switching to
 *   the live tail. NULL = instance default (`SUBSHELL_TERMINAL_REPLAY_LINES`,
 *   100). Long-running sessions used to ship their ENTIRE pipe-pane log into
 *   every attach, so opening a days-old terminal took minutes. Readers clamp
 *   to [1, 200]; the column stays nullable so the default follows the env.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").addColumn("terminal_replay_lines", "integer").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").dropColumn("terminal_replay_lines").execute();
}
