import type { IDockviewPanelHeaderProps } from "dockview-react";
import { Bell, Columns2, Rows2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenuRoot, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useWorkspaceDockContext } from "@/components/workspace-dock/context";
import { isPaneWaiting } from "@/lib/subshell-order";

/**
 * Compact in-tab form of the "waiting for you" chip: the full Badge does not
 * fit a dockview tab, so the marker is an amber bell carrying the chip's
 * message as its accessible name and tooltip. Guarded by
 * {@link isPaneWaiting} at the call site — the same predicate every other
 * view uses, never a fork of it.
 */
export function TabWaitingMarker() {
  return (
    <span
      className="flex shrink-0 items-center text-amber-400"
      role="img"
      aria-label="waiting for you"
      title="waiting for you"
    >
      <Bell className="h-3 w-3" aria-hidden />
    </span>
  );
}

/** Panel title (a dockview panel may hold an untitled panel — render "" then), kept live on `onDidTitleChange`. */
function useTitle(api: IDockviewPanelHeaderProps["api"]): string {
  const [title, setTitle] = useState<string>(api.title ?? "");
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title ?? ""));
    if (title !== (api.title ?? "")) setTitle(api.title ?? "");
    return () => disposable.dispose();
  }, [api, title]);
  return title;
}

/**
 * `defaultTabComponent` for `<DockviewReact>`: dockview's default tab rebuilt
 * with one addition — the waiting marker between the title and the × — and
 * its close rewired to `onRemovePane` so a tab's × and `<SubshellPane>`'s
 * "Remove pane" button are the same action.
 *
 * Why not wrap `DockviewDefaultTab`: at the pinned 8.2.0 it renders `children`
 * nowhere (its own title/close are positional children that override any
 * passed in) and hardcodes `className="dv-default-tab"` last, so a decoration
 * can neither be injected nor styled through it. This component therefore
 * mirrors the stock markup — the same `dv-default-tab*` classes (the theme
 * keeps styling them), the title subscription, the middle-click close, the
 * `aria-label="Close tab"` button — and adds the marker.
 *
 * The × interception (rather than listening for `DockviewApi.onDidRemovePanel`
 * and deleting the pane's server row whenever a panel disappears) is
 * deliberate: that event also fires when a panel is *moved* to another group
 * (dockview implements a cross-group drag/split as a remove from the source
 * group followed by an add to the destination, per its own docs:
 * "[onDidRemovePanel] may be called multiple times when moving panels").
 * Wiring removal to that event would delete a pane's subshell the moment the
 * user rearranged the tiling layout. The close control here only fires from
 * an actual click (or middle-click) on the tab — a move never touches it.
 *
 * The tab is also a right-click trigger (Base UI's `ContextMenu`, the same
 * primitive the sidebar rows use): Split right / Split down drive
 * `onSplitPane`, Close pane is the ×'s own action. The menu exists because
 * nothing on screen names dockview's drag gestures: dragging a tab to an
 * EDGE splits (the one that works) while dropping it on a group's CENTER
 * merges, which reads as the drag having done nothing — the operator's
 * report. Right-click cannot fight the drag: dockview's drag starts from a
 * native `dragstart`, which browsers fire for primary-button gestures only,
 * and its pointer fallback ignores mouse pointers entirely (touch/pen only),
 * so button 2 never arms either source.
 *
 * The pane is looked up in the live detail by panel id (the dock context
 * refreshes every poll), so the marker follows `subshellWaitingSince` without
 * the title itself ever being rewritten.
 */
export function SubshellTab(props: IDockviewPanelHeaderProps) {
  const { detail, onRemovePane, onSplitPane } = useWorkspaceDockContext();
  const title = useTitle(props.api);
  const pane = detail.panes.find((p) => p.id === props.api.id);
  const waiting = pane ? isPaneWaiting(pane) : false;
  // The trigger host doubles as the menu's anchor, as in ActionsMenu's
  // context mode: the box dockview already styles the tab with.
  const anchorRef = useRef<HTMLDivElement>(null);

  const close = useCallback(
    (event: { preventDefault(): void }) => {
      event.preventDefault();
      onRemovePane(props.api.id);
    },
    [onRemovePane, props.api.id],
  );

  // Middle-click closes the tab exactly like the stock default tab.
  const middleDown = useRef(false);

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger
        render={
          <div
            ref={anchorRef}
            className="dv-default-tab"
            onPointerDown={(event) => {
              middleDown.current = event.button === 1;
            }}
            onPointerUp={(event) => {
              if (middleDown.current && event.button === 1) {
                middleDown.current = false;
                close(event);
              }
            }}
            onPointerLeave={() => {
              middleDown.current = false;
            }}
          >
            <span className="dv-default-tab-content">{title}</span>
            {waiting && <TabWaitingMarker />}
            <button
              type="button"
              className="dv-default-tab-action"
              aria-label="Close tab"
              onPointerDown={(event) => event.preventDefault()}
              onClick={close}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        }
      />
      <DropdownMenuContent anchor={anchorRef} side="bottom" align="start" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onSplitPane(props.api.id, "right")}>
          <Columns2 className="h-4 w-4" aria-hidden />
          Split right
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitPane(props.api.id, "below")}>
          <Rows2 className="h-4 w-4" aria-hidden />
          Split down
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRemovePane(props.api.id)}>
          <X className="h-4 w-4" aria-hidden />
          Close pane
        </DropdownMenuItem>
      </DropdownMenuContent>
    </ContextMenuRoot>
  );
}
