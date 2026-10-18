import { ApiError, errMessage } from "@internal/node-admin";

/** Said of a server that predates the half of the split it is failing at. */
const STALE_SERVER = "the server is running an older build than this page; update and restart it, then try again";

/**
 * Checks that the server actually did what a split asked of it.
 *
 * `POST /api/workspaces` is asked for two things at once by a split: make the
 * workspace, and put the subshell being split into its first pane. A server
 * that predates the pane field does not fail — Elysia strips body fields its
 * schema does not declare — so it answers 200 with an ordinary empty
 * workspace, and the split then lands on a dock missing the very subshell it
 * came from. That was observed on 2026-09-14 against a dev SPA proxying to an
 * installed server binary built hours earlier.
 *
 * The response carries the evidence, so this reads it rather than trusting
 * the request: exactly one pane. Anything else is a server that did something
 * other than what was asked, and saying so beats navigating into a workspace
 * whose contents are wrong. (The draft flag this used to also check left with
 * spec 2026-10-17: there is no unsaved state to confirm.)
 * @param workspace - The created workspace, as the server described it
 * @returns A message to show the person, or null when the response is sound
 */
export function splitWorkspaceRefusal(workspace: { subshellCount?: number }): string | null {
  if (workspace.subshellCount === 1) return null;
  return `The server created a workspace but did not put this subshell in it: ${STALE_SERVER}.`;
}

/**
 * Explains a split whose create call FAILED outright.
 *
 * A 409 gets its own reading, and it is the same diagnosis by a different
 * route. A current server cannot 409 a workspace create at all — names are
 * not unique since 0058, and create has no other collision to hit — so a 409
 * here names an older server applying its old unique-name rule to a default
 * name the person never chose. Reporting its own words instead ("You already
 * have a workspace with that name") blames a name nobody typed and points at
 * nothing they can fix.
 * @param err - Whatever the create call threw
 * @returns The message to show the person
 */
export function splitCreateFailureMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return `workspace names are not unique on a current server, so ${STALE_SERVER}`;
  }
  // `errMessage` returns an Error's own message even when it is empty, which
  // would put an empty parenthetical on screen; fall back on the text, not
  // just on the type.
  return errMessage(err, "") || "the server could not create the workspace";
}
