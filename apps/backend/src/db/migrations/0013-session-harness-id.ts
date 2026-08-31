import type { Kysely } from "kysely";

/**
 * `harness_session_id`: the harness conversation id this session's pane runs
 * (or last ran) as part of the restart-resume feature. The backend PINS the
 * id at launch for resume-capable harnesses (Claude Code: `--session-id`),
 * so the restart and auto-restart paths can hand the same id back to continue
 * the conversation (`--resume <id>`) instead of starting cold. NULL = the
 * row predates the feature, its harness has no resume story, or nothing has
 * been pinned yet — restarts of such rows simply start a fresh conversation.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").addColumn("harness_session_id", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("sessions").dropColumn("harness_session_id").execute();
}
