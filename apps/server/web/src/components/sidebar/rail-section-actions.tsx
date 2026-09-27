import { Eye, EyeOff, Plus } from "lucide-react";
import type { JSX } from "react";
import { TippedIconButton } from "@/components/tipped-icon-button";

/**
 * The `+` (create) and eye (fold the section's list away) pair that rides the
 * right edge of a rail nav row, written for Subshells and Workspaces alike
 * (operator ask 2026-09-27). The two call sites were thirty identical lines
 * each, differing only in words and handlers.
 *
 * The eye sits LEFT of the + (`right-8`/`right-1`): the create button is the
 * row's primary affordance and keeps the corner nearest the edge. It carries
 * `aria-pressed` because it reports a state, not just an act.
 */
export function RailSectionActions({
  addTooltip,
  onAdd,
  hidden,
  showTooltip,
  hideTooltip,
  onToggleHidden,
}: {
  /** Tooltip (and aria-label) of the create button. */
  addTooltip: string;
  onAdd: () => void;
  /** Whether this section's list is currently folded away. */
  hidden: boolean;
  showTooltip: string;
  hideTooltip: string;
  onToggleHidden: () => void;
}): JSX.Element {
  return (
    <>
      <TippedIconButton
        tooltip={addTooltip}
        variant="ghost"
        size="icon"
        className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 text-muted-foreground"
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
      </TippedIconButton>
      <TippedIconButton
        tooltip={hidden ? showTooltip : hideTooltip}
        variant="ghost"
        size="icon"
        aria-pressed={hidden}
        className="absolute top-1/2 right-8 h-6 w-6 -translate-y-1/2 text-muted-foreground"
        onClick={onToggleHidden}
      >
        {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </TippedIconButton>
    </>
  );
}
