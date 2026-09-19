import { ApiError, errMessage } from "@internal/node-admin";

/** Said of a server that predates the half of the split it is failing at. */
const STALE_SERVER = "the server is running an older build than this page — update and restart it, then try again";

/**
 * Checks that the server actually did what a split asked of it.
 *
 * `POST /api/workspaces` is asked for two things at once by a split: make this
 * workspace a DRAFT, and put the subshell being split into its first pane. A
 * server that predates either one does not fail — Elysia strips body fields
 * its schema does not declare — so it answers 200 with an ordinary empty
 * workspace, and the split then lands on a dock missing the very subshell it
 * came from. That was observed on 2026-09-14 against a dev SPA proxying to an
 * installed server binary built hours earlier.
 *
 * The response carries the evidence, so this reads it rather than trusting the
 * request: exactly one pane and the draft flag set. Anything else is a server
 * that did something other than what was asked, and saying so beats navigating
 * into a workspace whose contents are wrong.
 * @param workspace - The created workspace, as the server described it
 * @returns A message to show the person, or null when the response is sound
 */
export function splitWorkspaceRefusal(workspace: { draft?: boolean; subshellCount?: number }): string | null {
  if (workspace.draft === true && workspace.subshellCount === 1) return null;
  return `The server created a workspace but did not put this subshell in it — ${STALE_SERVER}.`;
}

/**
 * Explains a split whose create call FAILED outright.
 *
 * A 409 gets its own reading, and it is the same diagnosis as above by a
 * different route. On a current server a draft sits outside the per-user
 * unique-name index entirely, so a split cannot collide with a name — it is
 * not even asked to be unique. A server that answers 409 is therefore one
 * writing the row as an ordinary saved workspace, i.e. one that never learned
 * about drafts. Reporting its own words instead ("You already have a workspace
 * with that name") blames a name the person never chose and points at nothing
 * they can fix.
 * @param err - Whatever the create call threw
 * @returns The message to show the person
 */
export function splitCreateFailureMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return `a name collision is impossible for an unsaved workspace, so ${STALE_SERVER}`;
  }
  // `errMessage` returns an Error's own message even when it is empty, which
  // would put an empty parenthetical on screen; fall back on the text, not
  // just on the type.
  return errMessage(err, "") || "the server could not create the workspace";
}
