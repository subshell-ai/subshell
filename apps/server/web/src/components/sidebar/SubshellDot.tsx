import { cn } from "@internal/node-admin";
import { INDICATOR_LABEL, type SubshellIndicator, subshellIndicator } from "@/lib/subshell-indicator";
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
 * The 6px state dot for one subshell — the rail's recent rows, and (since
 * 2026-09-20) the subshell page's own header, where it replaced a status
 * badge. Both read the SHARED indicator precedence, so a subshell can never
 * say one thing in the rail and another above its own terminal.
 *
 * `data-status` carries the RAW lifecycle status beside the rendered
 * indicator. The two are different questions — the indicator is what a person
 * should see (working, waiting, unreachable), the status is what the server
 * recorded — and the header used to spell the raw one out in words. Keeping
 * it as an attribute is what lets a test assert "the pane is genuinely
 * running" without depending on activity timing, which swings between
 * "working" and "idle" on a clock.
 */
export function SubshellDot({
  subshell,
  className,
  accessible = false,
}: {
  subshell: SubshellView;
  className?: string;
  /**
   * Announce the state to assistive technology.
   *
   * Off by default, which is the RAIL's posture: the row's link text is its
   * read-aloud content and a dot repeating the state would be noise (planning
   * deviation from spec §2, deliberate). The subshell page's header turns it
   * on, because there the dot is the only thing carrying the state — nothing
   * beside it says the word.
   */
  accessible?: boolean;
}) {
  const indicator = subshellIndicator(subshell);
  const label = INDICATOR_LABEL[indicator];
  return (
    <span
      {...(accessible ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      title={label}
      data-status={subshell.status}
      className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[indicator], className)}
    />
  );
}
