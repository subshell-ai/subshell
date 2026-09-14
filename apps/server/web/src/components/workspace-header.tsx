import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, type ReactNode, useState } from "react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { EditableText } from "@/components/editable-text";
import { SaveWorkspaceDialog } from "@/components/save-workspace-dialog";
import { Button } from "@/components/ui/button";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch, errMessage, isAlreadyGone } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import { WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * The bar above a workspace: back link, name, and the workspace-level
 * actions on the right.
 *
 * Rendered by each presentation rather than by the route, because `actions`
 * is the add-a-pane control and only the presentation knows how to add a
 * pane — the dock splits, the tab strip appends. Sharing the bar itself
 * keeps the two from drifting apart.
 *
 * The name edits in place (click it): the bar owns the PUT and the refresh,
 * so both presentations get editing without knowing anything about it. The
 * open detail page re-reads from the `["workspace", id]` query this updates;
 * the list page's cards re-read from the shared list query.
 *
 * **A DRAFT reads differently** (spec 2026-09-14 §4): an unsaved workspace is
 * one a split created, so it has no name anyone chose and nothing to rename —
 * the title is static "Unsaved workspace" and the actions gain Save/Discard
 * ahead of the caller's own. Everything else is identical, drafts being
 * ordinary workspace rows in every other respect.
 */
export function WorkspaceHeader({
  workspace,
  actions,
  onDiscarded,
}: {
  workspace: WorkspaceRow;
  /** Workspace-level controls, right-aligned. */
  actions?: ReactNode;
  /**
   * Called after a draft is discarded, INSTEAD of this bar navigating.
   *
   * The header does not know which panel is active, and the best landing
   * place after a discard is the subshell the user was looking at. Only the
   * presentation knows that, so it may supply this to land there; with no
   * handler the bar falls back to `/`, which is always correct and never
   * ideal.
   */
  onDiscarded?: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const invalidateWorkspaces = useInvalidateWorkspaces();
  const navigate = useNavigate();
  const [saveOpen, setSaveOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/workspaces/${workspace.id}`, { method: "PUT", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...WORKSPACE_QUERY_KEY, workspace.id] });
      void invalidateWorkspaces();
    },
  });

  /** Re-label the duplicate-name 409 with something a human can act on. */
  async function saveName(name: string): Promise<void> {
    try {
      await rename.mutateAsync(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      throw new Error(
        message.includes("409") ? "You already have a workspace with that name" : message || "Failed to save",
      );
    }
  }

  /**
   * Throws the draft away. The subshells on it are separate rows and keep
   * running, which the confirmation says out loud — a discard that read as
   * "close these two sessions" would never be clicked.
   */
  async function discard(): Promise<void> {
    const ok = await confirmAction({
      title: "Discard this unsaved workspace?",
      description: "Its subshells keep running.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      await apiFetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
    } catch (err) {
      // Already gone is the state this click wanted; anything else leaves the
      // draft where it is and SAYS so — navigating away from a failed delete
      // would report the discard as done.
      if (!isAlreadyGone(err)) {
        setDiscardError(errMessage(err, "Failed to discard"));
        setDiscarding(false);
        return;
      }
    }
    await invalidateWorkspaces();
    setDiscarding(false);
    if (onDiscarded) onDiscarded();
    else void navigate({ to: "/" });
  }

  return (
    <>
      <DetailBackHeader
        to="/workspaces"
        backLabel="Back to workspaces"
        title={
          workspace.draft ? (
            <span className="min-w-0 truncate font-strong text-muted-foreground">Unsaved workspace</span>
          ) : (
            <EditableText
              value={workspace.name}
              label="Rename workspace"
              onSave={saveName}
              className="min-w-0 font-strong"
              inputClassName="w-56"
            />
          )
        }
        actions={
          workspace.draft ? (
            <>
              <Button size="sm" onClick={() => setSaveOpen(true)}>
                Save workspace…
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void discard()} disabled={discarding}>
                {discarding ? "Discarding…" : "Discard"}
              </Button>
              {discardError && <span className="text-destructive text-detail">{discardError}</span>}
              {actions}
            </>
          ) : (
            actions
          )
        }
      />
      {workspace.draft && (
        <SaveWorkspaceDialog key={workspace.id} workspace={workspace} open={saveOpen} onOpenChange={setSaveOpen} />
      )}
    </>
  );
}
