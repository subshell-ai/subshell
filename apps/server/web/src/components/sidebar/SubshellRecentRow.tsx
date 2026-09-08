import { Link } from "@tanstack/react-router";
import { SubshellDot } from "@/components/sidebar/SubshellDot";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { cn } from "@/lib/utils";
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
 */
export function SubshellRecentRow({ subshell, active }: { subshell: SubshellView; active: boolean }) {
  const row = (
    <Link
      to="/subshells/$id"
      params={{ id: subshell.id }}
      draggable
      onDragStart={(e) => encodeSubshellDrag(e.dataTransfer, subshell.id)}
      title={subshell.workingDir ? `${subshell.name} — ${subshell.workingDir}` : undefined}
      className={cn(
        "flex items-start gap-2 rounded-md py-1 pr-3 pl-3 text-xs transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
      )}
    >
      <SubshellDot subshell={subshell} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{subshell.name}</span>
        {subshell.workingDir ? (
          <span className="block truncate text-[10px] opacity-70">{subshell.workingDir}</span>
        ) : null}
      </span>
    </Link>
  );
  return <SubshellActionsMenu subshell={subshell}>{row}</SubshellActionsMenu>;
}
