import { INDICATOR_LABEL, type SubshellIndicator, subshellIndicator } from "@/lib/subshell-indicator";
import { cn } from "@/lib/utils";
import type { SubshellView } from "@/types/subshell";

/**
 * Fill classes per state, in the rail's own visual language (spec
 * 2026-09-03 sidebar-quickadd §1 note): tone is a sidebar concern, so this
 * table lives with the dot, not in the shared indicator module. Two dead
 * states stay readable at 6px by shape, not just hue — `exited` is a faint
 * fill, `terminated` a hollow ring. Unlike the home cards' waiting chip, the
 * rail never animates.
 */
const DOT_CLASS: Record<SubshellIndicator, string> = {
  active: "bg-success",
  idle: "bg-muted-foreground",
  waiting: "bg-warning",
  exited: "bg-muted-foreground/50",
  terminated: "border border-muted-foreground",
  "node-offline": "bg-orange-500",
};

/**
 * The 6px state dot on a sidebar recent row. `aria-hidden` with a `title` —
 * the tooltip spells the word; the link text beside it stays the row's only
 * read-aloud content (planning deviation from spec §2, deliberate).
 */
export function SubshellDot({ subshell, className }: { subshell: SubshellView; className?: string }) {
  const indicator = subshellIndicator(subshell);
  return (
    <span
      aria-hidden
      title={INDICATOR_LABEL[indicator]}
      className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[indicator], className)}
    />
  );
}
