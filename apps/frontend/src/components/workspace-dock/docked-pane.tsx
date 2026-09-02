import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { SessionPane } from "@/components/session-pane";
import type { SessionTerminalHandles } from "@/components/session-terminal";
import { useWorkspaceDockContext } from "@/components/workspace-dock/context";

/** Params dockview holds for a "session" panel; see `addPanel` in `workspace-dock.tsx`. */
export interface DockedPaneParams {
  /** The pane this panel renders — looked up in the live detail on every render */
  paneId: string;
}

/**
 * The `"session"` panel renderer registered with `<DockviewReact>`. dockview
 * owns the frame, tab and close control, and (via `GroupHeaderActions`) the
 * maximize toggle and the heavier maximized-only chrome — this owns only the
 * content, `<SessionPane>`.
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
  const { detail, onRestart, onRemovePane, setSearchAddon } = useWorkspaceDockContext();
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
    (handles: SessionTerminalHandles) => setSearchAddon(paneId, handles.search),
    [setSearchAddon, paneId],
  );
  const handleTerminalDispose = useCallback(() => setSearchAddon(paneId, null), [setSearchAddon, paneId]);

  const pane = detail.panes.find((p) => p.id === paneId);
  // The 5s poll can see a cascade (the session — and with it this pane —
  // deleted from another device) before dockview's own layout catches up.
  // Rendering nothing is correct for that gap; `WorkspaceDock`'s
  // reconciliation effect closes the panel itself on the same update.
  if (!pane) return null;

  return (
    <SessionPane
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
