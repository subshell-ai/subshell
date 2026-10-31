import { Button, cn, ExplainedButton, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type JSX, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { PaneFocusHeader } from "@/components/pane-focus-header";
import { PreviewChooserDialog } from "@/components/preview/preview-chooser-dialog";
import { PreviewLabel } from "@/components/preview/preview-label";
import { PreviewTabContent } from "@/components/preview/preview-tab-content";
import { SubshellDot } from "@/components/subshell-dot";
import { SubshellPane } from "@/components/subshell-pane";
import { SubshellPicker } from "@/components/subshell-picker";
import { TabWaitingMarker } from "@/components/workspace-dock/subshell-tab";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { isPaneWaiting } from "@/lib/subshell-order";
import { onWorkspacePaneFocusRequest, setWorkspaceFocusedId, takePaneFocusOnArrive } from "@/lib/workspace-focus";
import { panelIdsInLayout } from "@/lib/workspace-layout";
import {
  onWorkspacePreviewRequest,
  parseWorkspacePreviewId,
  previewPanelId,
  previewParentId,
  previewResourceId,
  publishWorkspacePreviews,
  workspacePreviewLabel,
} from "@/lib/workspace-preview";
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
 *
 * The dot is the rail's own `<SubshellDot>` reading the SAME list cache
 * (`useSubshellRow`), so a tab's state — working blink, waiting, dead,
 * offline — speaks the one state language every other subshell surface
 * uses (the rail's cells' rule, applied to tabs). The raw `data-status`/
 * `data-alive` pair rides the dot and the e2e liveness assertions read it.
 * No row cached yet (list still loading) draws no dot — a missing dot is
 * honest, a wrong one is not.
 */
export function WorkspaceTab({ pane, active, onSelect, onRemove, waiting }: WorkspaceTabProps): JSX.Element {
  const subshell = useSubshellRow(pane.subshellId);
  return (
    <div
      // The strip finds its active tab by pane id and scrolls it into view
      // (see the effect in `<WorkspaceTabs>`).
      data-pane-id={pane.id}
      className={cn(
        "flex shrink-0 items-stretch border-b-2",
        active
          ? "border-primary bg-[linear-gradient(135deg,var(--button-primary-from),var(--button-primary-to))] text-[var(--button-primary-foreground)] hover:bg-[linear-gradient(135deg,var(--button-primary-hover-from),var(--button-primary-hover-to))]"
          : "border-transparent text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        className={cn("flex min-h-9 max-w-[220px] items-center gap-2 px-4 text-sm", active && "font-strong")}
      >
        {subshell && <SubshellDot subshell={subshell} className="mt-0" />}
        <span className="truncate">{pane.subshellName}</span>
        {waiting && <TabWaitingMarker />}
      </button>
      <ExplainedButton
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${pane.subshellName} from workspace`}
        className="flex h-9 w-11 shrink-0 items-center justify-center hover:bg-accent/50"
      >
        <X className="h-4 w-4" />
      </ExplainedButton>
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
 * The phone presentation: a scrollable tab strip over one `<SubshellPane>`
 * filling the rest of the viewport, mounted only where `useIsPhoneLayout`
 * says so — touch-primary AND below `WORKSPACE_TILING_MIN_WIDTH`. A narrow
 * desktop window does NOT come here (operator ruling 2026-09-27): it keeps
 * the dock, because a mouse gets no phone chrome for being small.
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
  const [chooserId, setChooserId] = useState<string | null>(null);
  const [previewIds, setPreviewIds] = useState<string[]>(() =>
    panelIdsInLayout(detail.workspace.layout).filter((id) => previewParentId(id)),
  );
  const previewPanes = previewIds.flatMap((id) => {
    const parsed = parseWorkspacePreviewId(id);
    const pane = detail.panes.find((row) => row.id === parsed?.paneId);
    return pane && parsed ? [{ ...pane, id, paneId: pane.id, view: parsed.view }] : [];
  });
  const selectedPreview = previewPanes.find((pane) => pane.id === selectedId);
  function closePreview(id: string, paneId: string) {
    setPreviewIds((ids) => ids.filter((entry) => entry !== id));
    if (selectedId === id) setSelectedId(paneId);
  }
  useEffect(
    () =>
      onWorkspacePreviewRequest((subshellId, view) => {
        const pane = detail.panes.find((row) => row.subshellId === subshellId);
        if (!pane) return false;
        if (!view) {
          setChooserId(subshellId);
          return true;
        }
        const id = previewPanelId(pane.id, view);
        setPreviewIds((ids) => [...ids.filter((old) => previewResourceId(old) !== previewResourceId(id)), id]);
        setSelectedId(id);
        return true;
      }),
    [detail.panes],
  );
  useEffect(() => {
    publishWorkspacePreviews(
      previewPanes.map((pane) => ({
        id: pane.id,
        paneId: pane.paneId,
        view: pane.view,
        subshellId: pane.subshellId,
        workspaceId: detail.workspace.id,
      })),
      selectedPreview?.id ?? null,
    );
  }, [previewPanes, selectedPreview, detail.workspace.id]);
  useEffect(() => () => publishWorkspacePreviews([], null), []);
  const { addPane, removePane, restartSubshell } = useWorkspacePaneMutations(detail.workspace.id);

  // Falls back to the first pane whenever `selectedId` doesn't name a pane
  // that still exists — including the moment the poll removes whichever pane
  // was selected — without needing a separate effect to "clamp" it.
  const selected =
    (selectedPreview && detail.panes.find((pane) => pane.id === selectedPreview.paneId)) ??
    detail.panes.find((p) => p.id === selectedId) ??
    detail.panes[0];

  // Publish the selected tab as the dock's equivalent focus, so the rail rings
  // one tab in the narrow presentation too (the dock owns this on wide ones).
  // Cleared on unmount. Keyed on the subshell id so a re-render that does not
  // move focus does not churn the store.
  const focusedSubshellId = selected?.subshellId ?? null;
  useEffect(() => {
    setWorkspaceFocusedId(focusedSubshellId);
  }, [focusedSubshellId]);
  useEffect(() => () => setWorkspaceFocusedId(null), []);
  // The narrow view's half of the arrival focus (see `workspace-dock.tsx`):
  // a rail click that navigated here selects the matching tab. Held until it
  // is honoured — a just-filed launch can arm before its pane row reaches
  // this mount's detail, and dropping it there would leave the strip on its
  // first-tab fallback instead of the tab that was clicked.
  const arrivalTargetRef = useRef<string | null>(null);
  useEffect(() => {
    // A newer arm replaces a held one, so a target whose row never arrives
    // cannot strand every later click in this mount (same rule in the dock).
    const fresh = takePaneFocusOnArrive();
    if (fresh) arrivalTargetRef.current = fresh;
    const target = arrivalTargetRef.current;
    if (!target) return;
    const pane = detail.panes.find((p) => p.subshellId === target);
    if (pane) {
      arrivalTargetRef.current = null;
      setSelectedId(pane.id);
    }
  }, [detail.panes]);
  // A focus request from the rail selects the matching tab instead of letting
  // the rail's link navigate out of the workspace.
  useEffect(
    () =>
      onWorkspacePaneFocusRequest((subId, scopedWorkspaceId) => {
        // Scoped requests name their branch: answer only for the workspace
        // this strip is standing on (see `requestWorkspacePaneFocus`).
        if (scopedWorkspaceId !== undefined && scopedWorkspaceId !== detail.workspace.id) {
          return false;
        }
        const pane = detail.panes.find((p) => p.subshellId === subId);
        if (!pane) return false;
        setSelectedId(pane.id);
        return true;
      }),
    [detail.panes, detail.workspace.id],
  );

  // The dock scrolls its own active tab into view on desktop; this strip is
  // the phone's, and a rail focus request switches the tab the eye never saw
  // move (operator report 2026-10-21: the header and terminal changed panes
  // while the strip still showed the old tabs). So when the active pane
  // changes, scroll its tab into view. `nearest` on both axes keeps a visible
  // tab from bouncing to the edge and stops the page taking a vertical jump,
  // and there is no smooth option: on a phone the move wants to be instant.
  // Pane and preview ids contain no quotes, so the attribute selector is safe.
  // The strip is already exempt from the terminal's foreign-scroll pin
  // (`data-terminal-controls-scroller`), so this scroll survives its resets.
  const stripRef = useRef<HTMLDivElement>(null);
  const selectedPaneId = selectedPreview?.id ?? selected?.id;
  useEffect(() => {
    if (!selectedPaneId) return;
    const tab = stripRef.current?.querySelector<HTMLElement>(`[data-pane-id="${selectedPaneId}"]`);
    tab?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [selectedPaneId]);

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
    // Removing this pane took the whole workspace with it: a workspace exists
    // exactly as long as it holds a tab (spec 2026-10-17), so this was the
    // last one and the server retired the row. There is no tab strip left to
    // re-select in, so go home.
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
      // Already here (a reload with the params still present, or the poll
      // landing before this effect) counts as landed — and still gets its tab
      // selected, the same intent the dock honours explicitly: the person
      // chose this pane, so the strip must not sit on its first-tab fallback.
      let landed = true;
      const existing = detail.panes.find((p) => p.subshellId === intent.subshellId);
      if (existing) {
        setSelectedId(existing.id);
      } else {
        landed = await handleAdd(intent.subshellId, intent.direction);
      }
      await onRefetch();
      // A pane that did NOT land keeps the params: the error banner would
      // unmount with this screen if we navigated clean, so the person who
      // pressed Split would land where they started with nothing said
      // (review, 2026-09-14). With the params kept, the banner stays up and a
      // reload retries the add.
      if (!landed) return;
      // Only now are the params spent — once the pane has actually landed, so
      // the claim above keeps a retry from double-adding.
      await navigate({ to: "/workspaces/$id", params: { id: detail.workspace.id }, search: {}, replace: true });
    })();
  }, [intent, claimIntent, detail, onRefetch, navigate]);

  return (
    <>
      {chooserId && <PreviewChooserDialog subshellId={chooserId} onClose={() => setChooserId(null)} />}
      <PaneFocusHeader
        fallbackName={detail.workspace.name}
        panes={detail.panes}
        workspaceId={detail.workspace.id}
        actions={<SubshellPicker workspaceId={detail.workspace.id} existing={detail.panes} onAdd={handleAdd} />}
      />
      {/* The selected pane's key bar owns home-indicator clearance. Padding
        this column as well would leave an extra safe-area band below it.
        An empty workspace has no key bar, so it keeps its own clearance. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col bg-terminal-canvas",
          detail.panes.length === 0 && "pb-[env(safe-area-inset-bottom)]",
        )}
      >
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
          be reachable.
          `data-terminal-controls-scroller` opts this strip out of the
          terminal's foreign-scroll pin (`shouldResetForeignScroll`,
          `lib/app-scroll-pin.ts`): while a pane's terminal is engaged, or the
          page is idle with focus nowhere, that pin resets every
          non-exempt scroller outside the terminal to its origin, which on a
          phone zeroed the strip's `scrollLeft` mid-pan (the snap-back under
          the finger). The key bar's horizontal scroller is exempted the same
          way; a tab strip that switches which terminal you see is a control
          of that terminal, not foreign scroll. */}
        <div
          ref={stripRef}
          data-terminal-controls-scroller
          className="flex min-w-0 items-stretch gap-0 overflow-x-auto border-b"
        >
          {detail.panes.map((pane) => (
            <WorkspaceTab
              key={pane.id}
              pane={pane}
              active={!selectedPreview && pane.id === selected?.id}
              onSelect={() => setSelectedId(pane.id)}
              onRemove={() => void handleRemovePane(pane.id)}
              waiting={isPaneWaiting(pane)}
            />
          ))}
          {previewPanes.map((pane) => (
            <div key={pane.id} data-pane-id={pane.id} className="flex shrink-0 items-center border-b-2">
              <Button
                variant={selectedPreview?.id === pane.id ? "secondary" : "ghost"}
                aria-current={selectedPreview?.id === pane.id}
                className="min-h-9 px-4"
                onClick={() => setSelectedId(pane.id)}
              >
                <PreviewLabel subshellId={pane.subshellId} view={pane.view} suffix={pane.subshellName} />
              </Button>
              <ExplainedButton
                type="button"
                aria-label={`Close ${workspacePreviewLabel(pane.view)} for ${pane.subshellName}`}
                onClick={() => closePreview(pane.id, pane.paneId)}
              >
                <X className="size-4" />
              </ExplainedButton>
            </div>
          ))}
        </div>
        <div className="relative min-h-0 flex-1">
          {selectedPreview && (
            <div className="absolute inset-0">
              <PreviewTabContent
                key={selectedPreview.id}
                subshellId={selectedPreview.subshellId}
                choice={selectedPreview.view}
                onClose={() => closePreview(selectedPreview.id, selectedPreview.paneId)}
              />
            </div>
          )}
          {detail.panes.length === 0 && (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              No subshells in this workspace yet. Add one above.
            </div>
          )}
          {detail.panes.map((pane) => (
            <div
              key={pane.id}
              className={cn("absolute inset-0", !selectedPreview && pane.id === selected?.id ? "block" : "hidden")}
            >
              <SubshellPane
                pane={pane}
                active={!selectedPreview && pane.id === selected?.id}
                // The phone's answer to `DockedPane`'s `visible && isActive`:
                // only the selected tab is shown and only one key bar may ride
                // the strip. `SubshellPane` still gates the bar on coarse
                // pointer itself, so a narrow desktop window gets no bar here
                // any more than in the dock.
                showKeyBar={!selectedPreview && pane.id === selected?.id}
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
