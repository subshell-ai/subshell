/**
 * Where a successful close must take the screen.
 *
 * Closing the subshell whose detail page is on screen (`/subshells/<id>`)
 * kills the page under the viewer, and every workspace-side close (the rail's
 * branch-row menu, the pane-focus bar's menu, the dock's Close) ends on the
 * DELETE, not on a navigation. Without this one rule each surface either
 * strands the viewer on the "Subshell not found" card — which is a deep-link
 * answer, not the answer to an act they just took — or navigates its own ad-hoc
 * way. The card itself stays put; this only decides who leaves and to where.
 */
export type CloseLanding =
  /** The workspace still has panes: the LAST remaining one, keeping the workspace context. */
  | { to: "/subshells/$id"; params: { id: string } }
  /**
   * Nothing is filed where the viewer stands, so the list is the landing. It
   * answers two acts: a detail-page close that left no panes behind, and a
   * close that retired the workspace on screen (its last tab was the closed
   * pane). There is no "land on the emptied workspace" case either way: the
   * same DELETE retires a workspace it just emptied (the close cascades its
   * pane rows and the owner's emptied holders go with them), so that id would
   * be cold the moment we navigated to it. And not `/`: landing there would
   * drop the viewer into an unrelated workspace right after their act, while
   * the list is the honest "nothing is filed here" answer. Matches the rail
   * drag-out, which lands on the list too.
   */
  | { to: "/subshells" }
  /** The page on screen is not the closed subshell's, and not a workspace this close just retired: nothing to re-navigate. */
  | null;

export interface CloseLandingInput {
  /**
   * The subshell id the CURRENT route carries — `subshellIdFromPath(location.pathname)`
   * — or null on any page that names none (the list, a workspace, `/`).
   */
  currentRouteId: string | null;
  /**
   * The workspace id the CURRENT route carries, `workspaceIdFromPath(location.pathname)`,
   * or null on any other page.
   */
  currentWorkspaceRouteId: string | null;
  /** The subshell whose close just succeeded. */
  closedId: string;
  /**
   * The id of the workspace the closed subshell was open in, or null when the
   * close came with no workspace context. It decides one thing: whether the
   * workspace this close emptied is the page on screen.
   */
  holderWorkspaceId: string | null;
  /**
   * The panes of the workspace the closed subshell was open in, as known at
   * click time. The closed pane needs no pre-filtering: it is excluded here.
   */
  workspacePanes: readonly { subshellId: string }[];
}

/**
 * Decides the post-close landing. A close must never yank a viewer off a page
 * that the close did not kill, so the answer is `null` unless one of two pages
 * died under it. The closed subshell's own detail page (`/subshells/<closedId>`)
 * lands on the last remaining pane of the workspace it was open in (membership
 * order, so the tab the eye was on is not the one that moved), or on
 * `/subshells` when nothing survived. A workspace page (`/workspaces/<id>`)
 * lands on `/subshells` only when this close retired the very workspace on
 * screen: the route names it, the closed subshell's holder is it, and no pane
 * survived. A workspace that still has tabs reconciles in place, and a close
 * whose holder is some other workspace leaves the live page alone. The emptied
 * workspace is never a landing, because the close that emptied it also retired
 * it. The rule is pure: callers read the routes and the pane list, then
 * navigate on the answer.
 * @param input - The closed subshell, the routes on screen, and the panes beside it
 * @returns Where to navigate, or null to leave the screen alone
 */
export function closeLandingFor({
  currentRouteId,
  currentWorkspaceRouteId,
  closedId,
  holderWorkspaceId,
  workspacePanes,
}: CloseLandingInput): CloseLanding {
  const survivors = workspacePanes.filter((pane) => pane.subshellId !== closedId);
  if (currentRouteId !== null && currentRouteId === closedId) {
    const last = survivors[survivors.length - 1];
    if (last) return { to: "/subshells/$id", params: { id: last.subshellId } };
    return { to: "/subshells" };
  }
  if (currentWorkspaceRouteId !== null && currentWorkspaceRouteId === holderWorkspaceId && survivors.length === 0)
    return { to: "/subshells" };
  return null;
}
