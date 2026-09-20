import { cn } from "@internal/node-admin";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One collapsible node heading in the rail's subshell list.
 *
 * Shaped after the nav group above it (chevron on the right, muted label, no
 * active gradient — a heading is not a page) so the rail has one collapsing
 * idiom rather than two. Two things it does differently, both because this
 * group's members are not nav items:
 *
 * - **The count is always rendered.** The list is capped per node, so a
 *   machine can hold more than it shows, and a collapsed group shows nothing
 *   at all — in both cases the number is the only thing saying how much work
 *   is over there.
 * - **Children are hidden, not unmounted**, the same rule the nav group
 *   follows: `aria-controls` has to resolve to a real element, and `hidden`
 *   takes the links out of the tab order so a shut group is not a keyboard
 *   trap of invisible stops.
 */
export function SubshellNodeGroup({
  nodeId,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  /** The node's id — keys the collapse preference; never rendered */
  nodeId: string;
  /** The node's NAME, which is what a person reads */
  label: string;
  /** How many subshells this node has, BEFORE the per-group cap */
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const listId = `sidebar-node-group-${nodeId}`;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-2 pl-3 text-detail text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
      >
        <span className="min-w-0 flex-1 truncate text-left font-strong" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums opacity-70">{count}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", !open && "-rotate-90")} />
      </button>
      <div id={listId} className={cn(!open && "hidden")}>
        {children}
      </div>
    </div>
  );
}
