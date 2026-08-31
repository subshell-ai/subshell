import type { SearchAddon } from "@xterm/addon-search";
import {
  type AddPanelPositionOptions,
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { SessionPicker } from "@/components/session-picker";
import { Button } from "@/components/ui/button";
import { type WorkspaceDockContextValue, WorkspaceDockProvider } from "@/components/workspace-dock/context";
import { DockedPane, type DockedPaneParams } from "@/components/workspace-dock/docked-pane";
import { GroupHeaderActions } from "@/components/workspace-dock/group-header-actions";
import { SessionTab } from "@/components/workspace-dock/session-tab";
import { WorkspaceHeader } from "@/components/workspace-header";
import { useDebouncedSave } from "@/hooks/use-debounced-save";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { apiFetch, errMessage } from "@/lib/api";
import { confirmDeleteSession, confirmTerminateSession } from "@/lib/session-confirmations";
import { panelIdsInLayout, panesMissingFromLayout, resolveAddPosition } from "@/lib/workspace-layout";
import type { SessionView } from "@/types/session";
import type { SplitDirection, WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/** Debounce window for persisting layout changes — collapses a drag/resize/split burst into one request. */
const LAYOUT_SAVE_DEBOUNCE_MS = 800;

/** Panel content renderers, keyed by the `component` id passed to `addPanel`. */
const components = {
  session: (props: IDockviewPanelProps<DockedPaneParams>) => <DockedPane {...props} />,
};

/** Props for {@link WorkspaceDock}. */
export interface WorkspaceDockProps {
  /** The workspace and its panes, from `useWorkspace`'s poll */
  detail: WorkspaceDetail;
  /** Re-fetches the workspace detail after a pane or session mutation */
  onRefetch: () => void;
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
export function WorkspaceDock({ detail, onRefetch }: WorkspaceDockProps): JSX.Element {
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
   * `handleAdd` — the session picker's and the drop handler's shared path
   * for actually attaching a session to the workspace.
   */
  const addPanel = useCallback((api: DockviewApi, pane: WorkspacePaneRow, position?: AddPanelPositionOptions) => {
    api.addPanel<DockedPaneParams>({
      id: pane.id,
      component: "session",
      title: pane.sessionName,
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
    if (detail.workspace.layout) {
      try {
        event.api.fromJSON(detail.workspace.layout as Parameters<typeof event.api.fromJSON>[0]);
        restored = true;
      } catch {
        // A layout we cannot restore is not worth losing the workspace
        // over — fall through and lay the panes out fresh below.
      }
    }
    // Everything already in the restored layout counts as known even
    // though `addPanel` was never called for it here.
    if (restored) {
      for (const id of panelIdsInLayout(detail.workspace.layout)) knownPaneIdsRef.current.add(id);
    }
    for (const pane of panesMissingFromLayout(restored ? detail.workspace.layout : null, detail.panes)) {
      // Same defensive check the reconciliation effect makes: a `fromJSON`
      // that threw partway can leave panels behind, and adding a duplicate id
      // would throw from inside dockview's own initialisation.
      if (!event.api.getPanel(pane.id)) addPanel(event.api, pane);
    }
    event.api.onDidLayoutChange(() => save.schedule(event.api.toJSON()));
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
    // client doing anything — deleting its session from /sessions cascades
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

  const { addPane, removePane, restartSession } = useWorkspacePaneMutations(detail.workspace.id);

  const handleRestart = useCallback(
    async (sessionId: string) => {
      try {
        const created = await restartSession(sessionId);
        const newPane = await addPane(created.id);
        // Only touch the old pane once the new one exists server-side — a
        // failure above leaves the old pane exactly as it was rather than
        // vanishing it with nothing to replace it.
        const old = detail.panes.find((p) => p.sessionId === sessionId);
        if (old) {
          const api = apiRef.current;
          if (api) {
            // Repoints in place: add the replacement into the old pane's
            // exact slot *before* closing it, so restarting a tile in a
            // multi-way split keeps its position instead of collapsing it
            // (the old pane is closed right after, leaving only the new one
            // where the old one was). `sessionStatus`/`sessionAlive` are set
            // directly rather than looked up — a just-restarted session is
            // always freshly running — and the next refetch overwrites this
            // placeholder row with the authoritative one at the same id.
            addPanel(
              api,
              {
                id: newPane.id,
                sessionId: created.id,
                sessionName: old.sessionName,
                sessionStatus: "running",
                sessionAlive: true,
                // Freshly restarted: no exit code to carry (the restart
                // clears it server-side too).
                sessionExitCode: null,
                // Freshly restarted: nobody is waiting yet (the next poll
                // carries the authoritative stamp either way).
                sessionWaitingSince: null,
                workingDir: old.workingDir,
              },
              { referencePanel: old.id, direction: "within" },
            );
          }
          apiRef.current?.getPanel(old.id)?.api.close();
          // `removePane` already converged on an already-gone row; a throw
          // here is a genuine failure, and the one thing it must not do is
          // leave the closed panel's id in the monotonic known set — the
          // row still exists, so forget the id and let the reconciliation
          // effect re-attach it on the next poll.
          try {
            await removePane(old.id);
          } catch (err) {
            knownPaneIdsRef.current.delete(old.id);
            throw err;
          }
        }
        onRefetch();
      } catch (err) {
        setError(errMessage(err, "Restart failed"));
      }
    },
    [detail.panes, addPanel, addPane, removePane, restartSession, onRefetch],
  );

  const handleRemovePane = useCallback(
    async (paneId: string) => {
      try {
        await removePane(paneId);
      } catch (err) {
        setError(errMessage(err, "Failed to remove pane"));
        return;
      }
      // The row is gone (or was already — the state this call wanted).
      // Close the tile either way rather than leaving the user a blank one
      // they have no way to clear.
      apiRef.current?.getPanel(paneId)?.api.close();
      onRefetch();
    },
    [removePane, onRefetch],
  );

  const handleTerminate = useCallback(
    async (sessionId: string) => {
      const name = detail.panes.find((p) => p.sessionId === sessionId)?.sessionName ?? sessionId;
      if (!(await confirmTerminateSession(name))) return;
      try {
        await apiFetch(`/api/sessions/${sessionId}/terminate`, { method: "POST" });
        onRefetch();
      } catch (err) {
        setError(errMessage(err, "Failed to terminate session"));
      }
    },
    [detail.panes, onRefetch],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const name = detail.panes.find((p) => p.sessionId === sessionId)?.sessionName ?? sessionId;
      if (!(await confirmDeleteSession(name))) return;
      try {
        // The FK cascade removes the pane server-side, so there is no separate
        // pane-removal call to make. The panel is closed by the reconciliation
        // effect above once the refetch below reports the pane gone;
        // `DockedPane`'s vanished-pane check covers the frame or two in
        // between, when the panel still exists but its pane does not.
        await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
        onRefetch();
      } catch (err) {
        setError(errMessage(err, "Failed to delete session"));
      }
    },
    [detail.panes, onRefetch],
  );

  const handleAdd = useCallback(
    async (sessionId: string, direction: SplitDirection) => {
      try {
        // The pane row is created first, and everything after this point
        // runs inside a `finally` that always calls `onRefetch` — once this
        // POST succeeds, the pane exists server-side no matter what happens
        // next (the session summary fetch below could still fail, e.g. a
        // concurrent delete), and it must never end up invisible: skipping
        // the refetch would leave a pane the user can't see, still offer its
        // session as available in the picker, and turn a retry into a
        // duplicate.
        const newPane = await addPane(sessionId);
        try {
          // The session's own summary is fetched fresh rather than taken
          // from any list the caller might have had on hand —
          // `SessionPicker` carries only an id, whether the session was
          // picked from the list or launched from the dialog — so the new
          // panel's title and content are correct from the moment it's
          // added instead of waiting on the next poll.
          const session = await apiFetch<SessionView>(`/api/sessions/${sessionId}`);
          const api = apiRef.current;
          if (api) {
            addPanel(
              api,
              {
                id: newPane.id,
                sessionId,
                sessionName: session.name,
                sessionStatus: session.status,
                sessionAlive: session.alive,
                // Authoritative, not a placeholder: the fresh session read
                // carries the exit code, so an added pane for a session
                // that already died explains itself immediately. The
                // waiting stamp rides the same read (the tab marker).
                sessionExitCode: session.exitCode,
                sessionWaitingSince: session.waitingSince,
                workingDir: session.workingDir,
              },
              // Everything added from the dialog splits from whatever pane
              // is currently focused: the dialog chooses a direction, never
              // a reference pane.
              resolveAddPosition(direction, api.activePanel?.id),
            );
          }
        } finally {
          // Runs even if the session summary fetch above failed: the pane
          // already exists server-side by this point, and `onRefetch` is
          // what makes it show up — the reconciliation effect above attaches
          // any pane `detail.panes` gains that this render never gave a
          // panel to, using the server's own join for its title, so the
          // pane still becomes visible (as a plain tab, not at the requested
          // split position) even when this fetch is the thing that failed.
          onRefetch();
        }
      } catch (err) {
        setError(errMessage(err, "Failed to add session"));
      }
    },
    [addPanel, addPane, onRefetch],
  );

  const contextValue = useMemo<WorkspaceDockContextValue>(
    () => ({
      detail,
      searchAddons,
      setSearchAddon,
      onRestart: (sessionId) => void handleRestart(sessionId),
      onRemovePane: (paneId) => void handleRemovePane(paneId),
      onTerminate: (sessionId) => void handleTerminate(sessionId),
      onDeleteSession: (sessionId) => void handleDeleteSession(sessionId),
    }),
    [detail, searchAddons, setSearchAddon, handleRestart, handleRemovePane, handleTerminate, handleDeleteSession],
  );

  return (
    <>
      {/* In the workspace header, not over the tiles: a group's own header is
          per-tile, and this control adds panes that belong to no particular
          one. It used to float over the bottom-right tile, where it covered
          that session's output. */}
      <WorkspaceHeader
        workspace={detail.workspace}
        actions={<SessionPicker workspaceId={detail.workspace.id} existing={detail.panes} onAdd={handleAdd} />}
      />
      <div className="relative flex-1 overflow-hidden bg-terminal-canvas">
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
        <WorkspaceDockProvider value={contextValue}>
          <DockviewReact
            className="dockview-theme-abyss h-full w-full"
            components={components}
            defaultTabComponent={SessionTab}
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
