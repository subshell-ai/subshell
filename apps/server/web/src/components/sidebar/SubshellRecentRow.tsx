import { Button, cn } from "@internal/node-admin";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, LayoutDashboard, Minus, Plus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { HarnessSubagentRows } from "@/components/harness-subagents";
import { TooltipLabelledLines } from "@/components/sidebar/TooltipLabelledLines";
import { useWorkspaceSidebarDrag } from "@/components/sidebar/workspace-sidebar-drag";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/subshell-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHarnessSubagents, useSelectHarnessAgent } from "@/hooks/use-harness-subagents";
import { useOpenPaneAsTab } from "@/hooks/use-open-pane-as-tab";
import { encodeSubshellDrag, setSubshellDragImage } from "@/lib/subshell-dnd";
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
  onOpen,
  inActiveWorkspace = false,
}: {
  subshell: SubshellView;
  /** The CURRENT pane: the dock's focused one, or the viewed `/subshells/:id`.
   * The one row that takes the accent fill and the ring. Membership in an
   * open workspace does not take this highlight (operator ruling 2026-10-17: every pane of
   * the workspace lit up, bold, and the row that answered "where am I" read
   * as six of them; the set still decides ordering and click resolution,
   * never brightness). The all-subshells browser marks membership with a
   * separate icon. No bold: the fill and ring carry focus alone. */
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
  /** Override plain-click navigation for a workspace-scoped browser. */
  onOpen?: () => void;
  /** Membership marker in the all-subshells browser, independent of focus. */
  inActiveWorkspace?: boolean;
}) {
  const openAsTab = useOpenPaneAsTab();
  const sidebarDrag = useWorkspaceSidebarDrag();
  const member = sidebarDrag?.workspace?.panes?.some((pane) => pane.subshellId === subshell.id);
  const workspaceAction =
    sidebarDrag?.workspace && (!member || sidebarDrag.workspace.subshellCount > 1)
      ? {
          label: member ? "Remove from workspace" : "Add to workspace",
          icon: member ? Minus : Plus,
          sidebar: true,
          onSelect: () => (member ? sidebarDrag.remove(subshell.id) : sidebarDrag.add(subshell.id)),
        }
      : undefined;
  // RUNNING is the row's two facts; a pane parked at running/alive:0 (or
  // flipped to terminated ahead of its alive bit) must not watch or fetch.
  const { data: agentState } = useHarnessSubagents(
    subshell.id,
    subshell.status === "running" && subshell.alive === true,
  );
  const selectAgent = useSelectHarnessAgent(subshell.id);
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const childrenId = useId();
  const hasSubagents = subshell.status === "running" && subshell.alive === true && !!agentState?.agents.length;
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
              onDragStart={(e) => {
                encodeSubshellDrag(e.dataTransfer, subshell.id);
                setSubshellDragImage(e.dataTransfer, e.currentTarget, e.clientX, e.clientY);
                sidebarDrag?.start(subshell.id);
              }}
              onDragEnd={() => sidebarDrag?.end()}
              // A plain left-click means the tab (operator ruling, spec
              // 2026-10-17): focus it here if it is open on screen, else go
              // to where it IS a tab, else make a workspace around it.
              // ⌘/ctrl/shift-click and middle-click ride the real href, which
              // stays the detail page.
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                if (focused && hasSubagents) {
                  setExpanded((value) => !value);
                  return;
                }
                if (agentState?.selectedId && agentState.canSelect)
                  selectAgent.mutate(null, {
                    // A reset that dies quietly is the worst outcome: the
                    // user goes on to the navigation below while the pane
                    // still shows the child. Say so on the thing that failed.
                    onError: () => toast.error("Couldn't return the pane to its main agent."),
                  });
                if (onOpen) {
                  onOpen();
                  return;
                }
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
                "my-1.5 flex min-w-0 items-start gap-2 rounded-md py-1 pr-12 pl-3 text-detail transition-colors",
                // ONE signal (operator ruling 2026-10-17): the CURRENT pane
                // wears the accent fill and the white ring; workspace
                // membership marks nothing, and nothing here goes bold.
                hasSubagents && !(subline ?? subshell.workingDir) && "min-h-12",
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
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{subshell.name}</span>
              {inActiveWorkspace && (
                <span role="img" aria-label="In active workspace" className="flex shrink-0 text-muted-foreground">
                  <LayoutDashboard className="size-3.5" aria-hidden="true" />
                </span>
              )}
            </span>
            {(subline ?? subshell.workingDir) ? (
              <span className="block truncate text-detail opacity-70">{subline ?? subshell.workingDir}</span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" arrow className="whitespace-pre-line break-words">
          <TooltipLabelledLines text={subshellRowTooltip(subshell, nodeLabel, agentLabel, presetLabel)} />
          {inActiveWorkspace && <p className="mt-1">In active workspace</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  return (
    <>
      <div className="relative">
        <SubshellActionsMenu subshell={subshell} workspaceAction={workspaceAction}>
          {row}
        </SubshellActionsMenu>
        {hasSubagents && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    /* Centered on the row's SECOND line (py-1 plus 1.5 detail
                       line boxes; both lines are truncate, so they never wrap).
                       Derived from the line-height token, not a font-size
                       multiple, so a type-scale edit moves it in step. */
                    className="absolute top-[calc(var(--spacing)+var(--text-detail)*var(--text-detail--line-height)*1.5)] left-1 size-5 -translate-y-1/2 text-muted-foreground [&_svg]:size-3"
                    aria-label={expanded ? "Collapse subagents" : "Expand subagents"}
                    aria-expanded={expanded}
                    aria-controls={childrenId}
                    onClick={() => setExpanded((value) => !value)}
                  />
                }
              >
                {expanded ? <ChevronDown /> : <ChevronRight />}
              </TooltipTrigger>
              <TooltipContent side="bottom">{expanded ? "Collapse subagents" : "Expand subagents"}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="absolute top-1/2 right-0 -translate-y-1/2">
          <SubshellActionsMenu subshell={subshell} workspaceAction={workspaceAction} />
        </div>
      </div>
      <div id={childrenId} hidden={!expanded || !hasSubagents}>
        <HarnessSubagentRows
          harnessId={subshell.harnessId}
          branchWorkspaceId={branchWorkspaceId}
          id={subshell.id}
          alive={subshell.status === "running" && subshell.alive === true}
        />
      </div>
    </>
  );
}
