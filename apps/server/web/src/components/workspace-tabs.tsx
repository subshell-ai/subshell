import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { SubshellPane } from "@/components/subshell-pane";
import { SubshellPicker } from "@/components/subshell-picker";
import { Button } from "@/components/ui/button";
import { TabWaitingMarker } from "@/components/workspace-dock/subshell-tab";
import { WorkspaceHeader } from "@/components/workspace-header";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { errMessage } from "@/lib/api";
import { isPaneWaiting } from "@/lib/subshell-order";
import { cn } from "@/lib/utils";
import type { SplitIntent } from "@/lib/workspace-split-intent";
import type { SplitDirection, WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/** Props for {@link WorkspaceTab}. */
export interface WorkspaceTabProps {
  /** The pane this tab switches to */
  pane: WorkspacePaneRow;
  /** Whether this is the currently selected tab */
  active: boolean;
  /** Selects this tab */
  onSelect: () => void;
  /** Removes this pane from the workspace (the tab's × — same action as `<SubshellPane>`'s "Remove pane" button) */
  onRemove: () => void;
  /** The pane's subshell is waiting for the operator — show the amber bell marker (see `<TabWaitingMarker>`) */
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
        <span className="truncate">{pane.subshellName}</span>
        {waiting && <TabWaitingMarker />}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${pane.subshellName} from workspace`}
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
  /**
   * The split that opened this page (`?add=…&dir=…`), consumed on mount; null
   * on an ordinary visit. The direction is ignored here, as it is for every
   * other add in this flat tab list.
   */
  intent: SplitIntent | null;
  /**
   * Claims {@link intent} for this presentation, answering true exactly once
   * per intent. Owned by the ROUTE, not by this component: the viewport
   * decides which presentation is mounted, and a per-component flag was spent
   * again by whichever one the breakpoint swapped in (`lib/intent-claim.ts`).
   */
  claimIntent: () => boolean;
  /**
   * Re-fetches the workspace detail after a pane or subshell mutation, and
   * RESOLVES when the new detail is in hand — the intent effect below waits
   * on it before stripping the URL params.
   */
  onRefetch: () => Promise<void>;
}

/**
 * The narrow presentation: a scrollable tab strip over one `<SubshellPane>`
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
export function WorkspaceTabs({ detail, intent, claimIntent, onRefetch }: WorkspaceTabsProps): JSX.Element {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { addPane, removePane, restartSubshell } = useWorkspacePaneMutations(detail.workspace.id);

  // Falls back to the first pane whenever `selectedId` doesn't name a pane
  // that still exists — including the moment the poll removes whichever pane
  // was selected — without needing a separate effect to "clamp" it.
  const selected = detail.panes.find((p) => p.id === selectedId) ?? detail.panes[0];

  /**
   * Adds `subshellId` to the workspace and selects it. `direction` comes from
   * `SubshellPicker`'s placement control, which this flat tab list has no use
   * for — every pane it adds becomes one more tab, never a split.
   */
  async function handleAdd(subshellId: string, _direction: SplitDirection): Promise<boolean> {
    let landed = false;
    try {
      const newPane = await addPane(subshellId);
      setSelectedId(newPane.id);
      landed = true;
    } catch (err) {
      setError(errMessage(err, "Failed to add subshell"));
    } finally {
      // Runs even on failure: `apiFetch` throws only on a non-2xx response,
      // so a thrown error here means the pane was never created and this is a
      // harmless no-op refetch — never a case of hiding a pane that exists.
      void onRefetch();
    }
    return landed;
  }

  /**
   * Restarts an exited/terminated subshell IN PLACE. Same id → the pane row
   * already references it, so unlike the old clone flow there is no
   * replacement pane to add and no old one to drop (that would duplicate the
   * tab). Just restart and refetch; the poll flips the tab back to running and
   * its pane remounts the terminal. (regression #13)
   */
  async function handleRestart(subshellId: string) {
    try {
      await restartSubshell(subshellId);
      void onRefetch();
    } catch (err) {
      setError(errMessage(err, "Restart failed"));
    }
  }

  /** Removes a pane from the workspace, leaving its subshell running (or gone) untouched. */
  async function handleRemovePane(paneId: string) {
    let workspaceDeleted = false;
    try {
      ({ workspaceDeleted } = await removePane(paneId));
    } catch (err) {
      setError(errMessage(err, "Failed to remove pane"));
      return;
    }
    // Removing this pane took the whole (unsaved) workspace with it — a draft
    // left with fewer than two panes is deleted server-side. There is no tab
    // strip left to re-select in, so leave for the pane that remains.
    if (workspaceDeleted) {
      const other = detail.panes.find((p) => p.id !== paneId);
      if (other) void navigate({ to: "/subshells/$id", params: { id: other.subshellId }, replace: true });
      else void navigate({ to: "/", replace: true });
      return;
    }
    // Gone (or already gone — the state this call wanted): refetch anyway
    // rather than leaving a stale tab the user has no way to clear.
    void onRefetch();
  }

  // The split that created this workspace: the second subshell was chosen
  // before the workspace existed, so attaching it is this page's job. Same
  // `handleAdd` as the picker's, so the tab is selected the same way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `handleAdd` is a plain function declaration and so differs every render — which costs nothing here, because `claimIntent` makes this effect's body run at most once per intent whatever its dependencies do.
  useEffect(() => {
    // The intent is spent the moment the add starts, not when it finishes: the
    // body below awaits a refetch, which re-renders this component.
    if (!intent || !claimIntent()) return;
    void (async () => {
      // Never a second pane for one subshell (regression #13): reloading with
      // the params still in the URL must not add the same subshell twice.
      // Already here (a reload with the params still present) counts as landed.
      let landed = true;
      if (!detail.panes.some((p) => p.subshellId === intent.subshellId)) {
        landed = await handleAdd(intent.subshellId, intent.direction);
      }
      await onRefetch();
      // A pane that did NOT land keeps the params. Stripping them would leave
      // a one-pane draft with no intent, which `useDiscardThinDraft` reads as
      // "discard and go back" — and the error banner would unmount with this
      // screen, so the person who pressed Split would land where they started
      // with nothing said (review, 2026-09-14). With the params kept, the guard
      // stays engaged, the banner stays up, and a reload retries the add.
      if (!landed) return;
      // Only now are the params spent. `useDiscardThinDraft` reads them as
      // "the second pane is still in flight", so stripping them any earlier
      // would auto-discard this draft from under the split that created it.
      await navigate({ to: "/workspaces/$id", params: { id: detail.workspace.id }, search: {}, replace: true });
    })();
  }, [intent, claimIntent, detail, onRefetch, navigate]);

  return (
    <>
      <WorkspaceHeader
        workspace={detail.workspace}
        actions={<SubshellPicker workspaceId={detail.workspace.id} existing={detail.panes} onAdd={handleAdd} />}
        // A discarded draft lands on the subshell the person was looking at
        // — the selected tab's — which only this presentation can name.
        onDiscarded={() => {
          const pane = detail.panes.find((p) => p.id === selectedId) ?? detail.panes[0];
          if (pane) void navigate({ to: "/subshells/$id", params: { id: pane.subshellId }, replace: true });
          else void navigate({ to: "/", replace: true });
        }}
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
              No subshells in this workspace yet. Add one above.
            </div>
          )}
          {detail.panes.map((pane) => (
            <div key={pane.id} className={cn("absolute inset-0", pane.id === selected?.id ? "block" : "hidden")}>
              <SubshellPane
                pane={pane}
                active={pane.id === selected?.id}
                onRestart={(subshellId) => void handleRestart(subshellId)}
                onRemovePane={(paneId) => void handleRemovePane(paneId)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
