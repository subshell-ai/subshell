import { apiFetch } from "@internal/node-admin";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SUBSHELL_QUERY_KEY,
  SUBSHELL_WORKSPACES_QUERY_KEY,
  SUBSHELLS_QUERY_KEY,
  WORKSPACE_QUERY_KEY,
} from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/** Query key for the caller's workspaces, shared by every mutation site. */
export const WORKSPACES_QUERY_KEY = ["workspaces"] as const;

/**
 * Everything to drop after a subshell RENAME, from every rename surface
 * (the page header, the workspace's pane-focus bar, the rail's title
 * dialog). The pane row carries the subshell's name, so the workspace
 * DETAIL (the dock's tab titles) and the LIST (the rail's tree) both
 * re-read it: missing the LIST is how tree rows kept showing the old name
 * after a rename (operator catch, 2026-10-17). One call so the sites
 * cannot drift apart.
 */
export function invalidateAfterRename(queryClient: QueryClient, subshellId: string): void {
  void queryClient.invalidateQueries({ queryKey: [...SUBSHELL_QUERY_KEY, subshellId] });
  void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
}

/**
 * Shared query for the caller's workspaces. Since spec 2026-10-17 each row
 * carries its panes, so the rail tree branches render from this one request.
 * The draft machinery (`?drafts=only`, the separate drafts read) left with the
 * column: a workspace exists exactly as long as it holds a tab.
 */
export function useWorkspaces() {
  return useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces"),
  });
}

/**
 * The one invalidator for workspace MEMBERSHIP moving: the LIST (the rail's
 * tree branches render from it), every per-subshell membership query
 * (`useSubshellWorkspaces` — keeps the subshell page's workspace link from
 * outliving a workspace it points at), and the OPEN detail. The detail is
 * load-bearing two ways: a Delete from the rail must reach the page standing
 * on that workspace (operator bug 2026-09-27: deleting the workspace you are
 * standing in left the page rendering the dead one's cached detail forever),
 * and the empty self-retire deletes the row the page is standing on.
 *
 * Every act that adds or removes a pane calls it: the pane-mutation seam
 * (`useWorkspacePaneMutations`), the rail's and dock's subshell closes (the
 * DELETE cascades the pane rows), and the feed's `subshell-gone` frame for
 * closes made elsewhere. The actor's own wake is not redundant with the
 * frame: the socket is a delivery, not a promise, and the surface that
 * pulled the trigger already knows what it did.
 */
export function invalidateWorkspaceMembership(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: SUBSHELL_WORKSPACES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
  ]).then(() => {});
}

/**
 * The hook shape of `invalidateWorkspaceMembership`, for call sites that act
 * inside React and want to await the settles (navigation ordering, a dialog
 * closing only once the caches are fresh).
 */
export function useInvalidateWorkspaces(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => invalidateWorkspaceMembership(queryClient);
}
