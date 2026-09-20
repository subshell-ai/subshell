import { cn } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { SubshellDot } from "@/components/sidebar/SubshellDot";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { subshellRowTooltip } from "@/lib/subshell-row-tooltip";
import type { SubshellView } from "@/types/subshell";

/**
 * One recent subshell in the sidebar: dot + name + working dir, right-click
 * for its actions menu (spec 2026-09-03 sidebar-context-menu), and HTML5-drag
 * — dragging it onto the workspace dock or a workspace card attaches it there
 * (spec 2026-09-03 sidebar-quickadd §5b). Left-click still navigates; a press
 * without movement never starts a drag, so the three gestures coexist.
 *
 * Takes the FULL entity (not the recents projection): the dot needs the
 * status fields, the menu needs the access level, and the sidebar's filter
 * mode has full entities anyway.
 *
 * The two labels are resolved by the CALLER and passed down rather than
 * queried here: both come from lists the rail already holds (the node
 * registry it groups by, the plugin catalog), and a row that fetched its own
 * would mount two queries per row.
 */
export function SubshellRecentRow({
  subshell,
  active,
  nodeLabel,
  agentLabel,
}: {
  subshell: SubshellView;
  active: boolean;
  /** The node's NAME (never its id); undefined drops the line from the tooltip */
  nodeLabel?: string;
  /** The harness's display name, falling back to its id — a readable slug */
  agentLabel: string;
}) {
  const row = (
    <Link
      to="/subshells/$id"
      params={{ id: subshell.id }}
      draggable
      onDragStart={(e) => encodeSubshellDrag(e.dataTransfer, subshell.id)}
      title={subshellRowTooltip(subshell, nodeLabel, agentLabel)}
      className={cn(
        "flex items-start gap-2 rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
        active
          ? "bg-accent font-strong text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
      )}
    >
      <SubshellDot subshell={subshell} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{subshell.name}</span>
        {subshell.workingDir ? (
          <span className="block truncate text-detail opacity-70">{subshell.workingDir}</span>
        ) : null}
      </span>
    </Link>
  );
  return <SubshellActionsMenu subshell={subshell}>{row}</SubshellActionsMenu>;
}
