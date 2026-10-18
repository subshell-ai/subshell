import { cn } from "@internal/node-admin";
import { Link, useNavigate } from "@tanstack/react-router";
import { TooltipLabelledLines } from "@/components/sidebar/TooltipLabelledLines";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/subshell-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenPaneAsTab } from "@/hooks/use-open-pane-as-tab";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { subshellRowTooltip } from "@/lib/subshell-row-tooltip";
import { armPaneFocusOnArrive, requestWorkspacePaneFocus } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";

/**
 * One recent subshell in the sidebar: dot + name + working dir, right-click
 * for its actions menu (spec 2026-09-03 sidebar-context-menu), and HTML5-drag
 * — dragging it onto the workspace dock or a workspace card attaches it there
 * (spec 2026-09-03 sidebar-quickadd §5b). Left-click still navigates; a press
 * without movement never starts a drag, so the three gestures coexist. The
 * full-detail tooltip (see `subshellRowTooltip`) hangs off the SAME element
 * through the tooltip's `render` prop — it composes rather than wraps, which
 * is what lets it carry the reveal without touching the three.
 *
 * Takes the FULL entity (not the recents projection): the dot needs the
 * status fields, the menu needs the access level, and the sidebar's filter
 * mode has full entities anyway.
 *
 * The two labels are resolved by the CALLER and passed down rather than
 * queried here: both come from lists the rail already holds (the node
 * registry it groups by, the plugin catalog), and a row that fetched its own
 * would mount two queries per row. `presetLabel` follows the same rule.
 */
export function SubshellRecentRow({
  subshell,
  focused,
  nodeLabel,
  agentLabel,
  presetLabel,
  subline,
  branchWorkspaceId,
}: {
  subshell: SubshellView;
  /** The CURRENT pane: the dock's focused one, or the viewed `/subshells/:id`.
   * The one row that takes the accent fill and the ring. Membership in an
   * open workspace marks NOTHING (operator ruling 2026-10-17: every pane of
   * the workspace lit up, bold, and the row that answered "where am I" read
   * as six of them; the set still decides ordering and click resolution,
   * never brightness). No bold: the fill and ring carry it alone. */
  focused: boolean;
  /** The group header's label — the node's NAME when resolved, its honest
   * fallback otherwise; one source of truth for header and tooltip alike */
  nodeLabel: string;
  /** The harness's display name, falling back to its id — a readable slug */
  agentLabel: string;
  /** The chosen preset's name (or its id when unresolvable); undefined when
   * the launch has no preset — the tooltip omits the line rather than
   * saying "none" */
  presetLabel?: string;
  /**
   * Text for the row's muted second line, REPLACING the working directory.
   * The "Cross-agent comms" section uses it to name the MACHINE each pane runs
   * on: its rows span every machine, so the header cannot say which one a row
   * is on the way a node group's header can, and the path is less useful there
   * than the machine. Every other rail row leaves it undefined (the path).
   */
  subline?: string;
  /**
   * The row sits inside a WORKSPACE's branch in the sidebar tree: the tab it
   * names lives in THAT workspace, so a plain click resolves there — focus the
   * dock when the branch's workspace is on screen, otherwise navigate to it
   * and arm the arrival focus. Without this the click would follow the
   * generic rule (the most recently touched holder), which answers a
   * different question than "the row you just clicked in THIS branch" (a
   * pane can sit in several workspaces).
   */
  branchWorkspaceId?: string;
}) {
  const openAsTab = useOpenPaneAsTab();
  const navigate = useNavigate();
  // `render`, not a wrapper: the Link below is simultaneously the nav, the
  // drag source and the context-menu subject, and the tooltip had to attach
  // to that element without becoming the thing that quietly kills one of
  // those gestures. It also had to LEAVE the native `title` it used to carry:
  // the browser paints native tooltips at the SYSTEM font size, so page zoom
  // (ctrl +/-) scaled the rows and left the tooltip behind (operator report
  // + screenshot, 2026-09-24). An in-page popup scales with everything else.
  // The 300 ms delay is what the browser's own title delay used to buy: a
  // mouse sweeping down the rail should not strobe six popups.
  const row = (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/subshells/$id"
              params={{ id: subshell.id }}
              draggable
              onDragStart={(e) => encodeSubshellDrag(e.dataTransfer, subshell.id)}
              // A plain left-click means the tab (operator ruling, spec
              // 2026-10-17): focus it here if it is open on screen, else go
              // to where it IS a tab, else make a workspace around it.
              // ⌘/ctrl/shift-click and middle-click ride the real href, which
              // stays the detail page.
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                if (branchWorkspaceId) {
                  // The branch names its own workspace, and the focus request
                  // is scoped to it: a pane filed in several workspaces must
                  // not answer a branch click by activating a DIFFERENT
                  // workspace's tab (review 2026-10-17). Refused here means
                  // "that branch is not the page on screen" — so navigate to
                  // the branch and focus there once its panes exist.
                  if (requestWorkspacePaneFocus(subshell.id, branchWorkspaceId)) return;
                  armPaneFocusOnArrive(subshell.id);
                  void navigate({ to: "/workspaces/$id", params: { id: branchWorkspaceId } });
                  return;
                }
                void openAsTab(subshell);
              }}
              className={cn(
                // `my-1.5` (12px between pills) separates the rows; the gap
                // also clears the focused row's ring, which paints OUTSIDE
                // the pill (operator device review 2026-09-27: `my-0.5` read
                // as no gap, `my-1` wanted a touch more).
                "my-1.5 flex items-start gap-2 rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
                // ONE signal (operator ruling 2026-10-17): the CURRENT pane
                // wears the accent fill and the white ring; workspace
                // membership marks nothing, and nothing here goes bold.
                focused
                  ? "bg-accent text-accent-foreground ring-1 ring-foreground/70"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
              )}
            />
          }
        >
          {/* The row's own tooltip carries the Status line — a native title on
              the dot would draw the same word twice, one mechanism at system
              size (the thing this row just left). */}
          <SubshellDot subshell={subshell} hideTitle />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{subshell.name}</span>
            {(subline ?? subshell.workingDir) ? (
              <span className="block truncate text-detail opacity-70">{subline ?? subshell.workingDir}</span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" arrow className="whitespace-pre-line break-words">
          <TooltipLabelledLines text={subshellRowTooltip(subshell, nodeLabel, agentLabel, presetLabel)} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  return <SubshellActionsMenu subshell={subshell}>{row}</SubshellActionsMenu>;
}
