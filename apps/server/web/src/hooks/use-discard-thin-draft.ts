import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch, isAlreadyGone } from "@/lib/api";
import type { SplitIntent } from "@/lib/workspace-split-intent";
import type { WorkspaceDetail } from "@/types/workspace";

/**
 * Auto-discards an unsaved workspace that no longer holds a split.
 *
 * A draft exists only to hold two or more panes side by side. Once it is down
 * to one — the other pane was closed, or its subshell was deleted from
 * somewhere else — it says nothing the subshell's own page does not, and
 * nothing would ever clean it up: drafts are excluded from `GET
 * /api/workspaces`, so they appear on no page a person can delete them from.
 * So the page it is open on sends the person back to the remaining subshell
 * and deletes the row.
 *
 * **The intent guard is what keeps the split flow alive.** A workspace created
 * by splitting is one pane for as long as it takes the second one to be added,
 * and the URL still carrying `?add=` is exactly the statement that the second
 * pane is in flight. `WorkspaceDock`/`WorkspaceTabs` strip those params only
 * after the refetch shows both panes, so a draft is never discarded out from
 * under the split that created it.
 * @param detail - The workspace detail, or undefined while it loads
 * @param intent - The split intent still in the URL, if any
 */
export function useDiscardThinDraft(detail: WorkspaceDetail | undefined, intent: SplitIntent | null): void {
  const navigate = useNavigate();
  const invalidateWorkspaces = useInvalidateWorkspaces();
  // Fires once per mount: the delete below is followed by a poll that 404s,
  // and without the guard a second pass would re-navigate over whatever the
  // person did next.
  const discardedRef = useRef(false);

  useEffect(() => {
    if (discardedRef.current) return;
    if (!detail?.workspace.draft) return;
    if (detail.panes.length >= 2) return;
    if (intent) return;
    discardedRef.current = true;

    const workspaceId = detail.workspace.id;
    const remaining = detail.panes[0];
    if (remaining) void navigate({ to: "/subshells/$id", params: { id: remaining.subshellId }, replace: true });
    else void navigate({ to: "/", replace: true });

    void (async () => {
      try {
        await apiFetch(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
      } catch (err) {
        // Already gone is the state this call wanted. Anything else has no
        // surface left to report on — this page has navigated away — so it
        // goes to the console and leaves the draft behind, reachable from the
        // subshell page's own workspace link.
        if (!isAlreadyGone(err)) console.error("Failed to discard unsaved workspace", err);
      }
      await invalidateWorkspaces();
    })();
  }, [detail, intent, navigate, invalidateWorkspaces]);
}
