import { apiPost } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { currentWorkspaceId, lastWorkspaceId } from "@/lib/current-workspace";
import { armPaneFocusOnArrive, requestWorkspacePaneFocus } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";
import type { WorkspaceRow } from "@/types/workspace";

/** The most recently touched of the workspaces that already hold this pane. */
export function filedWorkspaceFor(sub: SubshellView, workspaces: WorkspaceRow[]): WorkspaceRow | null {
  // The LIST arrives NAME-ordered (the repository sorts `listByUser` by name), so
  // recency has to be taken here: a pane filed in several workspaces should
  // answer "where is it open?" with the one you touched last, not the one
  // whose name sorts first (review 2026-10-17 caught the comment claiming an
  // order the server never sends).
  const holders = workspaces.filter((w) => (w.panes ?? []).some((p) => p.subshellId === sub.id));
  if (holders.length === 0) return null;
  return [...holders].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
}

/**
 * "Selecting a subshell means a tab" (operator ruling, spec 2026-10-17):
 * there is no subshell-view side of the app to fall out of. A plain click on
 * a pane row resolves to wherever that pane IS a tab:
 *
 * 1. it is already a tab of the workspace on screen → focus it (the dock's
 *    own event bus, no navigation),
 * 2. it is a tab of another workspace → open the most recently touched one
 *    and focus the tab on arrival,
 * 3. it is a tab of none → JOIN a workspace that exists (operator revision,
 *    2026-10-17: the same rule the launch follows — the one on screen, else
 *    the remembered one, else the most recently touched), and only an
 *    instance with no workspace at all creates one around the pane.
 *
 * A failed filing falls through to the plain `/subshells/$id` page: the link
 * did something, the terminal is reachable, and the rail never dead-clicks.
 * Middle-click and open-in-new-tab are untouched — they ride the row's real
 * href, which stays the detail page.
 */
export function useOpenPaneAsTab(): (sub: SubshellView) => Promise<void> {
  const navigate = useNavigate();
  const { data: workspaces } = useWorkspaces();
  const invalidate = useInvalidateWorkspaces();
  return useCallback(
    async (sub: SubshellView) => {
      if (requestWorkspacePaneFocus(sub.id)) return;
      // A LIST that has never answered (still loading, or the first read
      // failed) is not an answer of "no workspaces": filing on that guess
      // opens a duplicate window beside the one the pane already lives in
      // (the dashboard rule keeps error and empty distinct; review
      // 2026-10-17). The plain detail page is the honest fallback, and the
      // next click after the read lands files the pane for real. Once data
      // HAS arrived, a later failed refetch leaves the stale rows — the best
      // answer there is the last known truth, not a fresh window.
      if (workspaces === undefined) {
        await navigate({ to: "/subshells/$id", params: { id: sub.id } });
        return;
      }
      const holder = filedWorkspaceFor(sub, workspaces);
      if (holder) {
        armPaneFocusOnArrive(sub.id);
        await navigate({ to: "/workspaces/$id", params: { id: holder.id } });
        return;
      }
      const homes = workspaces;
      const remembered = lastWorkspaceId();
      const joinId =
        currentWorkspaceId() ??
        homes.find((w) => w.id === remembered)?.id ??
        [...homes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
      try {
        let filedInto: string;
        if (joinId) {
          // The idempotent pane-add is the SAME call the drop target and the
          // add-dialog make, so "click to file" is not a fourth filing path.
          await apiPost(`/api/workspaces/${joinId}/panes`, { subshellId: sub.id });
          filedInto = joinId;
        } else {
          const created = await apiPost<{ id: string }>("/api/workspaces", {
            name: sub.name,
            subshellId: sub.id,
          });
          filedInto = created.id;
        }
        await invalidate();
        armPaneFocusOnArrive(sub.id);
        await navigate({ to: "/workspaces/$id", params: { id: filedInto } });
      } catch {
        await navigate({ to: "/subshells/$id", params: { id: sub.id } });
      }
    },
    [navigate, workspaces, invalidate],
  );
}
