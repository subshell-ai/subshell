import { parseWorkspacePreviewId } from "@/lib/workspace-preview";

/**
 * Hands keyboard focus back to a pane's terminal when its tab is clicked.
 *
 * A dockview tab is focusable, so a click parks keyboard focus on the tab
 * itself and the pane's harness never sees the next Esc or keystroke: a docked
 * `/mcp list` report would not close while the turn streamed, and typing went
 * nowhere (operator report, 2026-11-09).
 *
 * The tab wrapper is dockview's, not ours, including a padding ring around the
 * rendered content, so this listens on the dock root and reads the pane id the
 * wrapper carries (`data-tab-panel-id`). A click only belongs to a tab when its
 * press began on that tab's own content and not on its close control; a drag
 * or selection that merely lands on a tab must leave focus where it was. Touch
 * taps are left to the pane's own tap gate, which is what decides whether the
 * soft keyboard opens, and a preview tab owns no terminal.
 */
export function wireTabFocus(root: HTMLElement, requestPaneFocus: (paneId: string) => void): () => void {
  /** The press the current gesture began with, when it began on a tab. */
  let press: { paneId: string; onTitle: boolean; pointerType: string } | null = null;

  const tabOf = (target: EventTarget | null): { paneId: string } | null => {
    const tab = target instanceof Element ? target.closest(".dv-tab") : null;
    const paneId = tab?.getAttribute("data-tab-panel-id");
    return paneId ? { paneId } : null;
  };

  const onPointerDown = (event: PointerEvent) => {
    const hit = tabOf(event.target);
    press = hit
      ? {
          paneId: hit.paneId,
          onTitle:
            event.button === 0 && !(event.target instanceof Element && event.target.closest(".dv-default-tab-action")),
          pointerType: event.pointerType,
        }
      : null;
  };

  const onClick = (event: MouseEvent) => {
    const hit = tabOf(event.target);
    const begun = press;
    press = null;
    // The press must be the one behind this click, on the same tab, and not on
    // its close control.
    if (!hit || !begun || begun.paneId !== hit.paneId || !begun.onTitle) return;
    if (begun.pointerType === "touch") return;
    if (parseWorkspacePreviewId(hit.paneId)) return;
    requestPaneFocus(hit.paneId);
  };

  const onPointerCancel = () => {
    press = null;
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("click", onClick);
  root.addEventListener("pointercancel", onPointerCancel);
  return () => {
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointercancel", onPointerCancel);
  };
}
