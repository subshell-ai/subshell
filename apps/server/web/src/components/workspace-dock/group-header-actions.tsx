import { Button } from "@internal/node-admin";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { TranscriptSearch } from "@/components/transcript-search";
import { useWorkspaceDockContext } from "@/components/workspace-dock/context";

/**
 * `rightHeaderActionsComponent` for `<DockviewReact>`. Always shows the
 * maximize/restore toggle — the one pane action with no room in a small
 * pane's own title bar — and, once the group is maximized, the heavier
 * chrome the tiling spec reserves for one enlarged subshell at a time:
 * Close and the transcript finder. (Close replaced the old Terminate/Delete
 * pair, spec 2026-09-03: the DELETE terminates a live process itself, so the
 * pane no longer needs a running/dead split here.)
 *
 * dockview creates one instance of this per group and keeps it attached to
 * that same group for its whole lifetime (unlike a panel, a group is never
 * reassigned to a different group), so `props.group`/`props.api` are safe to
 * read directly here — no captured value can go stale the way one would on a
 * panel that moves between groups.
 *
 * dockview does not re-render this component when maximize is toggled (the
 * underlying `DockviewGroupPanelApi` exposes no change event for it), so
 * this subscribes to the container-level `onDidMaximizedGroupChange` itself.
 */
export function GroupHeaderActions(props: IDockviewHeaderActionsProps) {
  const { detail, searchAddons, onCloseSubshell } = useWorkspaceDockContext();

  const [maximized, setMaximized] = useState(() => props.api.isMaximized());
  useEffect(() => {
    const disposable = props.containerApi.onDidMaximizedGroupChange((e) => {
      if (e.group === props.group) setMaximized(e.isMaximized);
    });
    return () => disposable.dispose();
  }, [props.containerApi, props.group]);

  // The poll can see a cascade (subshell deleted elsewhere) before dockview's
  // layout catches up, same as `DockedPane` — treat a vanished active panel
  // as "nothing to act on" rather than looking up a pane that no longer
  // exists.
  const pane = props.activePanel ? detail.panes.find((p) => p.id === props.activePanel?.id) : undefined;
  // Null until the terminal has mounted (or once it's detached) — a Find
  // button wired to a missing addon would just silently do nothing.
  const search = pane ? (searchAddons.get(pane.id) ?? null) : null;

  return (
    <div className="flex items-center gap-2 px-2">
      {maximized && pane && (
        <>
          <Button variant="destructive" size="sm" onClick={() => onCloseSubshell(pane.subshellId)}>
            <X className="h-3 w-3" /> Close
          </Button>
          {search && <TranscriptSearch search={search} onClose={() => {}} />}
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        // Reads live state at click time rather than branching on the
        // `maximized` state variable above: that state exists to render the
        // right icon/label, but by the time of a click it's one render cycle
        // behind whatever `onDidMaximizedGroupChange` last delivered, and
        // acting on it instead of the source of truth is exactly the kind of
        // staleness `DockedPane`'s captured-group bug came from.
        onClick={() => (props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize())}
        aria-label={maximized ? "Restore group" : "Maximize group"}
        title={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
      </Button>
    </div>
  );
}
