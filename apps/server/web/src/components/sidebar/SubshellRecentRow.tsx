import { cn } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDot } from "@/components/subshell-dot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { subshellRowTooltip } from "@/lib/subshell-row-tooltip";
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
  active,
  nodeLabel,
  agentLabel,
  presetLabel,
}: {
  subshell: SubshellView;
  active: boolean;
  /** The group header's label — the node's NAME when resolved, its honest
   * fallback otherwise; one source of truth for header and tooltip alike */
  nodeLabel: string;
  /** The harness's display name, falling back to its id — a readable slug */
  agentLabel: string;
  /** The chosen preset's name (or its id when unresolvable); undefined when
   * the launch has no preset — the tooltip omits the line rather than
   * saying "none" */
  presetLabel?: string;
}) {
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
              className={cn(
                "flex items-start gap-2 rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
                active
                  ? "bg-accent font-strong text-accent-foreground"
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
            {subshell.workingDir ? (
              <span className="block truncate text-detail opacity-70">{subshell.workingDir}</span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line break-words">
          {subshellRowTooltip(subshell, nodeLabel, agentLabel, presetLabel)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  return <SubshellActionsMenu subshell={subshell}>{row}</SubshellActionsMenu>;
}
