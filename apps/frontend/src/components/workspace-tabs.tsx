import { X } from "lucide-react";
import { type JSX, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { SessionPane } from "@/components/session-pane";
import { SessionPicker } from "@/components/session-picker";
import { Button } from "@/components/ui/button";
import { TabWaitingMarker } from "@/components/workspace-dock/session-tab";
import { WorkspaceHeader } from "@/components/workspace-header";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { errMessage } from "@/lib/api";
import { isPaneWaiting } from "@/lib/session-order";
import { cn } from "@/lib/utils";
import type { SplitDirection, WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/** Props for {@link WorkspaceTab}. */
export interface WorkspaceTabProps {
  /** The pane this tab switches to */
  pane: WorkspacePaneRow;
  /** Whether this is the currently selected tab */
  active: boolean;
  /** Selects this tab */
  onSelect: () => void;
  /** Removes this pane from the workspace (the tab's × — same action as `<SessionPane>`'s "Remove pane" button) */
  onRemove: () => void;
  /** The pane's session is waiting for the operator — show the amber bell marker (see `<TabWaitingMarker>`) */
  waiting: boolean;
}

/**
 * One entry in the scrollable tab strip. Both the label and the × are sized
 * to a 44px touch target — the desktop's dense dockview tab (a small label
 * plus a ~12px close glyph) is not reusable here, it is built for a mouse.
 */
export function WorkspaceTab({ pane, active, onSelect, onRemove, waiting }: WorkspaceTabProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex shrink-0 items-stretch border-b-2",
        active ? "border-primary bg-terminal-tab-active" : "border-transparent",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        className={cn(
          "flex min-h-11 max-w-[220px] items-center gap-2 px-4 text-sm",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="truncate">{pane.sessionName}</span>
        {waiting && <TabWaitingMarker />}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${pane.sessionName} from workspace`}
        className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Props for {@link WorkspaceTabs}. */
export interface WorkspaceTabsProps {
  /** The workspace and its panes, from `useWorkspace`'s poll */
  detail: WorkspaceDetail;
  /** Re-fetches the workspace detail after a pane or session mutation */
  onRefetch: () => void;
}

/**
 * The narrow presentation: a scrollable tab strip over one `<SessionPane>`
 * filling the rest of the viewport, used below `WORKSPACE_TILING_MIN_WIDTH`.
 *
 * The narrow presentation deliberately never writes `layout_json`. If it did,
 * opening a workspace on a phone would flatten a carefully split desktop
 * arrangement into a flat tab list, with no undo. Panes can be added, removed
 * and switched here; the split tree is left exactly as the desktop left it,
 * and a pane added here reaches the desktop through `panesMissingFromLayout`
 * on its next load. Accordingly this file must never import
 * `useDebouncedSave` and must never call `PUT /api/workspaces/:id/layout`.
 *
 * Every pane is mounted at once, each behind its own `active` flag — the same
 * rule `WorkspaceDock` uses for a background tab in a tile group — so exactly
 * one pane holds a WebSocket and a WebGL context at a time: the selected one.
 * Switching tabs is a tap on the strip only; xterm owns horizontal
 * touch-drag for text selection inside the terminal, so no swipe gesture is
 * wired up here to compete with it.
 */
export function WorkspaceTabs({ detail, onRefetch }: WorkspaceTabsProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { addPane, removePane, restartSession } = useWorkspacePaneMutations(detail.workspace.id);

  // Falls back to the first pane whenever `selectedId` doesn't name a pane
  // that still exists — including the moment the poll removes whichever pane
  // was selected — without needing a separate effect to "clamp" it.
  const selected = detail.panes.find((p) => p.id === selectedId) ?? detail.panes[0];

  /**
   * Adds `sessionId` to the workspace and selects it. `direction` comes from
   * `SessionPicker`'s placement control, which this flat tab list has no use
   * for — every pane it adds becomes one more tab, never a split.
   */
  async function handleAdd(sessionId: string, _direction: SplitDirection) {
    try {
      const newPane = await addPane(sessionId);
      setSelectedId(newPane.id);
    } catch (err) {
      setError(errMessage(err, "Failed to add session"));
    } finally {
      // Runs even on failure: `apiFetch` throws only on a non-2xx response,
      // so a thrown error here means the pane was never created and this is a
      // harmless no-op refetch — never a case of hiding a pane that exists.
      onRefetch();
    }
  }

  /**
   * Restarts an exited/terminated session IN PLACE. Same id → the pane row
   * already references it, so unlike the old clone flow there is no
   * replacement pane to add and no old one to drop (that would duplicate the
   * tab). Just restart and refetch; the poll flips the tab back to running and
   * its pane remounts the terminal. (regression #13)
   */
  async function handleRestart(sessionId: string) {
    try {
      await restartSession(sessionId);
      onRefetch();
    } catch (err) {
      setError(errMessage(err, "Restart failed"));
    }
  }

  /** Removes a pane from the workspace, leaving its session running (or gone) untouched. */
  async function handleRemovePane(paneId: string) {
    try {
      await removePane(paneId);
    } catch (err) {
      setError(errMessage(err, "Failed to remove pane"));
      return;
    }
    // Gone (or already gone — the state this call wanted): refetch anyway
    // rather than leaving a stale tab the user has no way to clear.
    onRefetch();
  }

  return (
    <>
      <WorkspaceHeader
        workspace={detail.workspace}
        actions={<SessionPicker workspaceId={detail.workspace.id} existing={detail.panes} onAdd={handleAdd} />}
      />
      <div className="flex min-h-0 flex-1 flex-col bg-terminal-canvas">
        {error && (
          <ErrorBanner
            message={error}
            action={
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-destructive underline"
                onClick={() => setError(null)}
              >
                Dismiss
              </Button>
            }
          />
        )}
        {/* Tabs alone here: the picker lives in the workspace header, above
          this strip. It is the only add-a-pane path guaranteed to work on
          touch, and with enough panes to overflow, a strip it lived inside
          would require scrolling to reach the one control that must always
          be reachable. */}
        <div className="flex min-w-0 items-stretch gap-0 overflow-x-auto border-b">
          {detail.panes.map((pane) => (
            <WorkspaceTab
              key={pane.id}
              pane={pane}
              active={pane.id === selected?.id}
              onSelect={() => setSelectedId(pane.id)}
              onRemove={() => void handleRemovePane(pane.id)}
              waiting={isPaneWaiting(pane)}
            />
          ))}
        </div>
        <div className="relative min-h-0 flex-1">
          {detail.panes.length === 0 && (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              No sessions in this workspace yet — add one above.
            </div>
          )}
          {detail.panes.map((pane) => (
            <div key={pane.id} className={cn("absolute inset-0", pane.id === selected?.id ? "block" : "hidden")}>
              <SessionPane
                pane={pane}
                active={pane.id === selected?.id}
                onRestart={(sessionId) => void handleRestart(sessionId)}
                onRemovePane={(paneId) => void handleRemovePane(paneId)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
