import type { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { SubshellPane } from "@/components/subshell-pane";
import type { SubshellTerminalHandles } from "@/components/subshell-terminal";
import { type PaneFocusOutcome, useWorkspaceDockContext } from "@/components/workspace-dock/context";

/** Params dockview holds for a "subshell" panel; see `addPanel` in `workspace-dock.tsx`. */
export interface DockedPaneParams {
  /** The pane this panel renders — looked up in the live detail on every render */
  paneId: string;
}

/**
 * Focus a terminal whose pane just became active. Dockview keeps a fresh
 * panel's render overlay at `visibility: hidden` for a frame while it is
 * positioned, and a hidden textarea takes no focus — so retry until the
 * textarea accepts it. `initial` is where focus was when the tab was clicked,
 * so a click somewhere else during that wait wins. `settle` reports how the
 * attempt ended: a terminal that left the DOM before accepting focus is not
 * an answer, because activation rebuilt it and the replacement retries.
 */
function focusTerminal(
  term: Terminal,
  initial: Element | null,
  settle: (outcome: PaneFocusOutcome) => void,
  attempts = 20,
): void {
  const textarea = term.textarea;
  if (!textarea?.isConnected) {
    settle("retired");
    return;
  }
  const current = document.activeElement;
  if (current && current !== initial && current !== textarea && current !== document.body) {
    settle("abandoned");
    return;
  }
  term.focus();
  if (document.activeElement === textarea) {
    settle("focused");
    return;
  }
  if (attempts <= 0) {
    settle("abandoned");
    return;
  }
  requestAnimationFrame(() => focusTerminal(term, initial, settle, attempts - 1));
}

/**
 * The `"subshell"` panel renderer registered with `<DockviewReact>`. dockview
 * owns the frame, tab and close control, and (via `GroupHeaderActions`) the
 * maximize toggle and the heavier maximized-only chrome — this owns only the
 * content, `<SubshellPane>`.
 *
 * `active` is derived from dockview's own visibility (seeded from
 * `props.api.isVisible`, kept live via `onDidVisibilityChange`), never from
 * geometry — it is true for every tiled pane and false only for a background
 * tab in a tab group, which is exactly when detaching the socket and
 * releasing the WebGL context is correct. This is also the property that
 * keeps the panel from ever remounting: dockview moves, splits and resizes
 * this same component instance in place (the panel was added with
 * `renderer: "always"`), so nothing here ever tears the terminal down except
 * a genuine visibility change.
 *
 * Deliberately holds nothing derived from `props.api.group`: a panel's group
 * is reassigned in place when it moves to another group (drag, split), and
 * nothing here would be notified of that reassignment — a value captured
 * from it in a previous render goes stale silently. Group-scoped state
 * (maximize) lives in `GroupHeaderActions` instead, which is genuinely
 * per-group for its whole lifetime.
 */
export function DockedPane(props: IDockviewPanelProps<DockedPaneParams>) {
  const { detail, onRestart, onRemovePane, setSearchAddon, setPaneFocusTarget } = useWorkspaceDockContext();
  const { paneId } = props.params;

  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    const disposable = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => disposable.dispose();
  }, [props.api]);

  // Focus, as dockview sees it: exactly one panel per group is active, so on
  // a touch device the accessory key bar rides the pane the user last tapped
  // (tiled panes on a phone would otherwise stack one bar each). Visibility
  // gates it too — a background tab is never "active" in the user's sense
  // for long, and its terminal is detached anyway.
  const [isActive, setIsActive] = useState(props.api.isActive);
  useEffect(() => {
    const disposable = props.api.onDidActiveChange((e) => setIsActive(e.isActive));
    return () => disposable.dispose();
  }, [props.api]);

  const handleTerminalReady = useCallback(
    (handles: SubshellTerminalHandles) => {
      setSearchAddon(paneId, handles.search);
      // A tab click asks for this pane's focus; when the click also made a
      // background tab visible, the request arrives before the new terminal
      // mounts and is held until this publish (see `requestPaneFocus`).
      setPaneFocusTarget(paneId, (initial, settle) => focusTerminal(handles.term, initial, settle));
    },
    [setSearchAddon, setPaneFocusTarget, paneId],
  );
  const handleTerminalDispose = useCallback(() => {
    setSearchAddon(paneId, null);
    setPaneFocusTarget(paneId, null);
  }, [setSearchAddon, setPaneFocusTarget, paneId]);

  const pane = detail.panes.find((p) => p.id === paneId);
  // An invalidation refetch can see a cascade (the subshell — and with it this
  // pane — deleted from another device) before dockview's own layout catches
  // up. Rendering nothing is correct for that gap; `WorkspaceDock`'s
  // reconciliation effect closes the panel itself on the same update.
  if (!pane) return null;

  return (
    <SubshellPane
      pane={pane}
      active={visible}
      showKeyBar={visible && isActive}
      onRestart={onRestart}
      onRemovePane={onRemovePane}
      onReady={handleTerminalReady}
      onDispose={handleTerminalDispose}
    />
  );
}
