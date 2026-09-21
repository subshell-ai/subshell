import type { SearchAddon } from "@xterm/addon-search";
import {
  type AddPanelPositionOptions,
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { apiFetch, Button, errMessage } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, type DragEvent as ReactDragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { SubshellPicker } from "@/components/subshell-picker";
import { type WorkspaceDockContextValue, WorkspaceDockProvider } from "@/components/workspace-dock/context";
import { DockedPane, type DockedPaneParams } from "@/components/workspace-dock/docked-pane";
import { GroupHeaderActions } from "@/components/workspace-dock/group-header-actions";
import { SubshellTab } from "@/components/workspace-dock/subshell-tab";
import { WorkspaceHeader } from "@/components/workspace-header";
import { useDebouncedSave } from "@/hooks/use-debounced-save";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { confirmCloseSubshell } from "@/lib/subshell-confirmations";
import { readSubshellDrag, SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
import {
  normalizeLegacyLayout,
  panelIdsInLayout,
  panesMissingFromLayout,
  resolveAddPosition,
  splitTarget,
} from "@/lib/workspace-layout";
import type { SplitIntent } from "@/lib/workspace-split-intent";
import type { SubshellView } from "@/types/subshell";
import type { SplitDirection, WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/** Debounce window for persisting layout changes — collapses a drag/resize/split burst into one request. */
const LAYOUT_SAVE_DEBOUNCE_MS = 800;

/** True for OUR drags only — a file-upload drag or dockview's own tab drag never arms the overlay. */
function isSubshellDrag(e: ReactDragEvent): boolean {
  return e.dataTransfer.types.includes(SUBSHELL_DND_TYPE);
}

/** Panel content renderers, keyed by the `component` id passed to `addPanel`. */
const components = {
  subshell: (props: IDockviewPanelProps<DockedPaneParams>) => <DockedPane {...props} />,
};

/** Props for {@link WorkspaceDock}. */
export interface WorkspaceDockProps {
  /** The workspace and its panes, from `useWorkspace`'s poll */
  detail: WorkspaceDetail;
  /**
   * The split that opened this page (`?add=…&dir=…`), consumed once the dock
   * is ready; null on an ordinary visit.
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
 * The wide presentation: a tmux-style tiling layout on `dockview-react`.
 *
 * Every panel is added with `renderer: "always"`, which is what keeps a
 * panel's DOM — and the terminal inside it — alive when dockview hides,
 * moves, splits or resizes it: the same component instance is relocated in
 * place rather than unmounted and remounted. `DockedPane`'s notion of
 * `active` comes from dockview's own visibility instead, true for every
 * tiled pane and false only for a background tab in a tab group, which is
 * exactly when detaching the socket and releasing the WebGL context is
 * correct. Together these replace the canvas's viewport virtualization with
 * a rule that needs no geometry at all.
 */
export function WorkspaceDock({ detail, intent, claimIntent, onRefetch }: WorkspaceDockProps): JSX.Element {
  const navigate = useNavigate();
  const apiRef = useRef<DockviewApi | null>(null);
  // Pane ids this component has ever given a panel to. The ongoing
  // reconciliation effect below diffs against this — not against dockview's
  // live layout — so a pane whose panel was already closed (the tab's ×,
  // "Remove pane", or a restart replacing it — all of which delete the pane's
  // server row) is never mistaken for one that needs re-attaching. This set
  // only ever grows: a delete's `onRefetch` can return before the server has
  // actually dropped the row, and if this set forgot the id in the meantime
  // the reconciliation effect below would see it as "missing a panel" and
  // resurrect the tile it was just closing.
  const knownPaneIdsRef = useRef<Set<string>>(new Set());
  // Pane ids that have appeared in at least one server response. The
  // reconciliation effect only closes a panel once its pane was actually seen
  // from the server and then vanished; a panel this client added moments ago
  // has not reached a poll yet, and must not be mistaken for a deleted one.
  const serverSeenPaneIdsRef = useRef<Set<string>>(new Set());
  const [searchAddons, setSearchAddons] = useState<ReadonlyMap<string, SearchAddon>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Sidebar-drag affordance (spec 2026-09-03 sidebar-quickadd §5c): true while
  // our payload hovers the dock. The depth counter is what keeps the overlay
  // from flickering: dragenter/dragleave fire as the pointer crosses every
  // child of the wrapper, and only the outermost pair is a real leave.
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  // True once dockview has handed over its api and the stored layout has been
  // restored. The split intent cannot be acted on before that: `handleAdd`
  // places the new panel relative to the active one, and there is no panel —
  // and no `apiRef.current` — until `onReady` has run.
  const [ready, setReady] = useState(false);

  const setSearchAddon = useCallback((paneId: string, addon: SearchAddon | null) => {
    setSearchAddons((prev) => {
      const next = new Map(prev);
      if (addon) next.set(paneId, addon);
      else next.delete(paneId);
      return next;
    });
  }, []);

  const save = useDebouncedSave<unknown>(
    (layout, signal) =>
      apiFetch(`/api/workspaces/${detail.workspace.id}/layout`, {
        method: "PUT",
        body: JSON.stringify({ layout }),
        signal,
      }),
    LAYOUT_SAVE_DEBOUNCE_MS,
    // Without this the one piece of state this component actually persists
    // fails silently: every tile keeps responding, no banner appears, and the
    // arrangement reverts to the last successful save on the next reload.
    (err) => setError(errMessage(err, "Failed to save layout")),
  );

  /**
   * Adds a panel for a pane, optionally splitting from a reference panel or
   * group. Used by `onReady`, by the reconciliation effect below, and by
   * `handleAdd` — the subshell picker's and the drop handler's shared path
   * for actually attaching a subshell to the workspace.
   */
  const addPanel = useCallback((api: DockviewApi, pane: WorkspacePaneRow, position?: AddPanelPositionOptions) => {
    api.addPanel<DockedPaneParams>({
      id: pane.id,
      component: "subshell",
      title: pane.subshellName,
      renderer: "always",
      params: { paneId: pane.id },
      ...(position ? { position } : {}),
    });
    knownPaneIdsRef.current.add(pane.id);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dockview calls onReady exactly once, at mount — the callback below runs against whatever detail/save were at that moment, and later changes are covered by the reconciliation effect further down.
  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Tracks whether `fromJSON` actually populated the layout, so a
    // restore failure falls through to laying every pane out fresh — not
    // just the ones absent from the (unrestored) stored layout's panel ids.
    let restored = false;
    // Saved layouts predating the component rename still name the panel
    // renderer `"session"`; `fromJSON` throws on the unknown key, which
    // would silently rebuild every workspace's arrangement once. Rewrite
    // before restore (see `normalizeLegacyLayout`).
    const layout = detail.workspace.layout ? normalizeLegacyLayout(detail.workspace.layout) : null;
    if (layout) {
      try {
        event.api.fromJSON(layout as Parameters<typeof event.api.fromJSON>[0]);
        restored = true;
      } catch {
        // A layout we cannot restore is not worth losing the workspace
        // over — fall through and lay the panes out fresh below.
      }
    }
    // Everything already in the restored layout counts as known even
    // though `addPanel` was never called for it here.
    if (restored) {
      for (const id of panelIdsInLayout(layout)) knownPaneIdsRef.current.add(id);
    }
    for (const pane of panesMissingFromLayout(restored ? layout : null, detail.panes)) {
      // Same defensive check the reconciliation effect makes: a `fromJSON`
      // that threw partway can leave panels behind, and adding a duplicate id
      // would throw from inside dockview's own initialisation.
      if (!event.api.getPanel(pane.id)) addPanel(event.api, pane);
    }
    event.api.onDidLayoutChange(() => save.schedule(event.api.toJSON()));
    setReady(true);
  }, []);

  // Attaches a pane added elsewhere — another device, or the narrow
  // presentation, which never writes a layout — as a new tab. `handleRestart`
  // adds its own replacement panel directly (at the old pane's exact slot),
  // so in practice this covers everything this client didn't create itself.
  // `api.getPanel` is checked defensively so this can never throw trying to
  // add a panel id dockview already has.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const live = new Set<string>();
    for (const pane of detail.panes) {
      live.add(pane.id);
      serverSeenPaneIdsRef.current.add(pane.id);
      if (knownPaneIdsRef.current.has(pane.id)) continue;
      knownPaneIdsRef.current.add(pane.id);
      if (!api.getPanel(pane.id)) addPanel(api, pane);
    }
    // The mirror of the loop above: a pane can also disappear without this
    // client doing anything — deleting its subshell from /subshells cascades
    // the pane row away, and another device can remove a pane directly.
    // Nothing else closes those panels, so without this the tile lingers as
    // a dead terminal until a reload. Guarded on `serverSeenPaneIdsRef` so a
    // panel added here a moment ago, still absent from the in-flight poll,
    // is never closed as though it had been deleted.
    for (const panel of [...api.panels]) {
      if (live.has(panel.id)) continue;
      if (!serverSeenPaneIdsRef.current.has(panel.id)) continue;
      panel.api.close();
    }
  }, [detail.panes, addPanel]);

  const { addPane, removePane, restartSubshell } = useWorkspacePaneMutations(detail.workspace.id);

  // Restart is IN-PLACE: same id, so the workspace_panes row already points
  // at the (now-revived) subshell — there is nothing to add or remove. A clone
  // dance (add replacement pane, drop the old one) would create a SECOND row
  // for one subshell: a duplicate tile on other devices and two terminals on
  // one tmux pane. (regression #13) The next refetch flips the pane back to
  // running — which remounts a dead pane's terminal (SubshellPane switches
  // branches) and lets a live pane's socket reconnect — so just restart + refetch.
  const handleRestart = useCallback(
    async (subshellId: string) => {
      try {
        await restartSubshell(subshellId);
        void onRefetch();
      } catch (err) {
        setError(errMessage(err, "Restart failed"));
      }
    },
    [restartSubshell, onRefetch],
  );

  const handleRemovePane = useCallback(
    async (paneId: string) => {
      let workspaceDeleted = false;
      try {
        ({ workspaceDeleted } = await removePane(paneId));
      } catch (err) {
        setError(errMessage(err, "Failed to remove pane"));
        return;
      }
      // Removing this pane took the whole (unsaved) workspace with it — a
      // draft left with fewer than two panes is deleted server-side. There is
      // no dock left to close a tile in, so leave for the pane that remains.
      if (workspaceDeleted) {
        const other = detail.panes.find((p) => p.id !== paneId);
        if (other) void navigate({ to: "/subshells/$id", params: { id: other.subshellId }, replace: true });
        else void navigate({ to: "/", replace: true });
        return;
      }
      // The row is gone (or was already — the state this call wanted).
      // Close the tile either way rather than leaving the user a blank one
      // they have no way to clear.
      apiRef.current?.getPanel(paneId)?.api.close();
      void onRefetch();
    },
    [removePane, onRefetch, detail.panes, navigate],
  );

  const handleCloseSubshell = useCallback(
    async (subshellId: string) => {
      const name = detail.panes.find((p) => p.subshellId === subshellId)?.subshellName ?? subshellId;
      if (!(await confirmCloseSubshell(name))) return;
      try {
        // The FK cascade removes the pane server-side, so there is no separate
        // pane-removal call to make. The panel is closed by the reconciliation
        // effect above once the refetch below reports the pane gone;
        // `DockedPane`'s vanished-pane check covers the frame or two in
        // between, when the panel still exists but its pane does not.
        await apiFetch(`/api/subshells/${subshellId}`, { method: "DELETE" });
        void onRefetch();
      } catch (err) {
        setError(errMessage(err, "Failed to close subshell"));
      }
    },
    [detail.panes, onRefetch],
  );

  // The tab context menu's split acts. `splitTarget` resolves the destination;
  // the two api calls then run in that order, and the order is load-bearing:
  // `addGroup` first builds the EMPTY destination group beside the tab's group
  // (a split beside a peer, not the container-edge move a reference-less
  // `moveTo` would give), and `moveTo` relocates the SAME panel object into
  // it, so its `renderer: "always"` terminal keeps its DOM and socket through
  // the move. No pane row changes server-side; the debounced layout save
  // picks the new arrangement up from `onDidLayoutChange` on its own. When
  // the move empties the source group dockview removes that group itself, so
  // a one-tab workspace splits into a visual no-op rather than a husk.
  const handleSplitPane = useCallback((panelId: string, direction: Exclude<SplitDirection, "within">) => {
    const api = apiRef.current;
    const target = api ? splitTarget(api, panelId, direction) : null;
    if (!api || !target) return;
    const group = api.addGroup(target);
    api.getPanel(panelId)?.api.moveTo({ group });
  }, []);

  /** Resolves true when the pane row now exists server-side; false when it does not and the banner says why. */
  const handleAdd = useCallback(
    async (subshellId: string, direction: SplitDirection): Promise<boolean> => {
      try {
        // The pane row is created first, and everything after this point
        // runs inside a `finally` that always calls `onRefetch` — once this
        // POST succeeds, the pane exists server-side no matter what happens
        // next (the subshell summary fetch below could still fail, e.g. a
        // concurrent delete), and it must never end up invisible: skipping
        // the refetch would leave a pane the user can't see, still offer its
        // subshell as available in the picker, and turn a retry into a
        // duplicate.
        const newPane = await addPane(subshellId);
        try {
          // The subshell's own summary is fetched fresh rather than taken
          // from any list the caller might have had on hand —
          // `SubshellPicker` carries only an id, whether the subshell was
          // picked from the list or launched from the dialog — so the new
          // panel's title and content are correct from the moment it's
          // added instead of waiting on the next poll.
          const subshell = await apiFetch<SubshellView>(`/api/subshells/${subshellId}`);
          const api = apiRef.current;
          if (api) {
            addPanel(
              api,
              {
                id: newPane.id,
                subshellId,
                subshellName: subshell.name,
                subshellStatus: subshell.status,
                subshellAlive: subshell.alive,
                // Authoritative, not a placeholder: the fresh subshell read
                // carries the exit code, so an added pane for a subshell
                // that already died explains itself immediately. The
                // waiting stamp rides the same read (the tab marker).
                subshellExitCode: subshell.exitCode,
                subshellWaitingSince: subshell.waitingSince,
                workingDir: subshell.workingDir,
              },
              // Everything added from the dialog splits from whatever pane
              // is currently focused: the dialog chooses a direction, never
              // a reference pane.
              resolveAddPosition(direction, api.activePanel?.id),
            );
          }
        } finally {
          // Runs even if the subshell summary fetch above failed: the pane
          // already exists server-side by this point, and `onRefetch` is
          // what makes it show up — the reconciliation effect above attaches
          // any pane `detail.panes` gains that this render never gave a
          // panel to, using the server's own join for its title, so the
          // pane still becomes visible (as a plain tab, not at the requested
          // split position) even when this fetch is the thing that failed.
          void onRefetch();
        }
      } catch (err) {
        setError(errMessage(err, "Failed to add subshell"));
        return false;
      }
      return true;
    },
    [addPanel, addPane, onRefetch],
  );

  // The split that created this workspace. The picker chose (or launched) the
  // second subshell before the workspace existed, so attaching it is this
  // page's job — done through the same `handleAdd` every later add uses, so
  // the direction the picker asked for is honoured by one code path.
  useEffect(() => {
    // The intent is spent the moment the add starts, not when it finishes: the
    // body below awaits a refetch, which re-renders this component, and
    // without the claim that second pass would add the pane again.
    if (!ready || !intent || !claimIntent()) return;
    void (async () => {
      // Never a second pane for one subshell (regression #13): reloading with
      // the params still in the URL, or a poll that landed before this effect
      // ran, must not add the same subshell twice.
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
      // "the second pane is still in flight", so stripping them before the
      // refetch shows both panes would auto-discard this draft from under the
      // split that just created it.
      await navigate({ to: "/workspaces/$id", params: { id: detail.workspace.id }, search: {}, replace: true });
    })();
  }, [ready, intent, claimIntent, detail.panes, detail.workspace.id, handleAdd, onRefetch, navigate]);

  const handleDockDrop = useCallback(
    (e: ReactDragEvent) => {
      if (!isSubshellDrag(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDropActive(false);
      const id = readSubshellDrag(e.dataTransfer);
      if (!id) return;
      // Never a second pane for one subshell (regression #13): the server
      // does not dedupe, so this client checks its own authoritative pane
      // list — if it is already here, just show it.
      const existingPane = detail.panes.find((p) => p.subshellId === id);
      if (existingPane) {
        apiRef.current?.getPanel(existingPane.id)?.api.setActive();
        return;
      }
      // Same shared path as the "Add subshell" dialog: "right" splits from
      // the active panel, exactly what "add it over there" means.
      void handleAdd(id, "right");
    },
    [detail.panes, handleAdd],
  );

  const contextValue = useMemo<WorkspaceDockContextValue>(
    () => ({
      detail,
      searchAddons,
      setSearchAddon,
      onRestart: (subshellId) => void handleRestart(subshellId),
      onRemovePane: (paneId) => void handleRemovePane(paneId),
      onSplitPane: handleSplitPane,
      onCloseSubshell: (subshellId) => void handleCloseSubshell(subshellId),
    }),
    [detail, searchAddons, setSearchAddon, handleRestart, handleRemovePane, handleSplitPane, handleCloseSubshell],
  );

  return (
    <>
      {/* In the workspace header, not over the tiles: a group's own header is
          per-tile, and this control adds panes that belong to no particular
          one. It used to float over the bottom-right tile, where it covered
          that subshell's output. */}
      <WorkspaceHeader
        workspace={detail.workspace}
        actions={<SubshellPicker workspaceId={detail.workspace.id} existing={detail.panes} onAdd={handleAdd} />}
        // A discarded draft lands on the subshell the person was looking at
        // — the active panel's — which only this presentation can name.
        onDiscarded={() => {
          const activeId = apiRef.current?.activePanel?.id;
          const pane = detail.panes.find((p) => p.id === activeId) ?? detail.panes[0];
          if (pane) void navigate({ to: "/subshells/$id", params: { id: pane.subshellId }, replace: true });
          else void navigate({ to: "/", replace: true });
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: an HTML5 DROP
          target, not a click handler — drag events carry no tap/keyboard
          semantics to lose, and the keyboard-reachable equivalent of this
          gesture is the "Add subshell" dialog beside it. */}
      <div
        className="relative flex-1 overflow-hidden bg-terminal-canvas"
        onDragEnter={(e) => {
          if (!isSubshellDrag(e)) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setDropActive(true);
        }}
        onDragOver={(e) => {
          if (!isSubshellDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        }}
        onDrop={handleDockDrop}
      >
        {error && (
          <ErrorBanner
            variant="floating"
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
        {dropActive && (
          // Same visual language as the terminal's file-drop outline
          // (TerminalDropOverlay) — one dashed-ring idiom for "drop here".
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-primary/60 border-dashed bg-background/60 backdrop-blur-sm">
            <p className="rounded-md bg-background/95 px-3 py-1.5 text-sm shadow">Drop to add this subshell</p>
          </div>
        )}
        <WorkspaceDockProvider value={contextValue}>
          <DockviewReact
            className="dockview-theme-abyss h-full w-full"
            components={components}
            defaultTabComponent={SubshellTab}
            rightHeaderActionsComponent={GroupHeaderActions}
            // Belt-and-suspenders alongside the explicit `renderer: "always"`
            // on every `addPanel` call: dockview falls back to
            // "onlyWhenVisible" for any panel whose serialized state omits a
            // renderer, and dockview's own tab drags re-create panels — this
            // makes it impossible for any path to get the setting wrong.
            defaultRenderer="always"
            onReady={onReady}
          />
        </WorkspaceDockProvider>
      </div>
    </>
  );
}
