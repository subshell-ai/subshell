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
  return "The server created a workspace but did not put this subshell in it — it is likely running an older build than this page. Update and restart the server, then try again.";
}
