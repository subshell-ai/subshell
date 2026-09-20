import { cn } from "@internal/node-admin";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One collapsible node heading in the rail's subshell list.
 *
 * Shaped after the nav group above it (chevron on the right, muted label, no
 * active gradient — a heading is not a page) so the rail has one collapsing
 * idiom rather than two. Three things it does differently, all because this
 * group's members are not nav items:
 *
 * - **The count is always rendered.** The list is capped per node, so a
 *   machine can hold more than it shows, and a collapsed group shows nothing
 *   at all — in both cases the number is the only thing saying how much work
 *   is over there. It counts the group's PRE-CAP total; while the rail is
 *   filtering, the group is built from the matches, so the same cell counts
 *   matches instead. Both are the useful number for their mode, and neither
 *   is wrong — said here because the slot silently changing what it counts
 *   is exactly how a future "the count is wrong" issue would start.
 * - **Children are hidden, not unmounted**, the same rule the nav group
 *   follows: `aria-controls` has to resolve to a real element, and `hidden`
 *   takes the links out of the tab order so a shut group is not a keyboard
 *   trap of invisible stops.
 * - **The label carries a `title`.** When the registry has not resolved the
 *   node the label is a short id or "unknown node", and the full id on hover
 *   is the only thing that says WHICH machine — the reveal `nodePill` gives a
 *   card, for the same reason.
 */
export function SubshellNodeGroup({
  nodeId,
  label,
  title,
  count,
  open,
  disabled = false,
  onToggle,
  children,
}: {
  /** The node's id — keys `aria-controls` and the DOM id; never rendered */
  nodeId: string;
  /** The node's NAME (or the honest fallback when the registry cannot say one) */
  label: string;
  /** The header's hover text — the name when known, the full node id otherwise */
  title: string;
  /** How many subshells this node has, BEFORE the per-group cap */
  count: number;
  open: boolean;
  /**
   * Render the chevron inert: while the rail is FILTERING every group is
   * forced open, so a press would move nothing visible — and a press that
   * also wrote its state to localStorage would shut the group the moment the
   * filter cleared, a choice the user never saw themselves make. Inert
   * header, untouched preference.
   */
  disabled?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  // Keyed by node id, never by the label: the id is stable across a rename,
  // and a DOM id derived from a name could collide or carry characters that
  // make the `aria-controls` selector unreliable.
  const listId = `sidebar-node-group-${nodeId}`;
  return (
    <div>
      <button
        type="button"
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-2 pl-3 text-detail text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground",
          disabled && "pointer-events-none",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left font-strong" title={title}>
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
