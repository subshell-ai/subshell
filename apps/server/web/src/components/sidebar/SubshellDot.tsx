import { cn } from "@internal/node-admin";
import { Bell } from "lucide-react";
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
 * Bell tone per state (spec 2026-09-23): the glyph says "pushed and you have
 * not looked", the colour keeps saying what the dot said. Spelled apart from
 * DOT_CLASS on purpose — those are background fills, an icon colors by
 * `text-*`.
 */
const BELL_TONE: Record<SubshellIndicator, string> = {
  active: "text-success",
  idle: "text-muted-foreground",
  waiting: "text-warning",
  exited: "text-muted-foreground/50",
  terminated: "text-muted-foreground",
  "node-offline": "text-orange-500",
};

/**
 * The 6px state dot for one subshell — the rail's recent rows, and (since
 * 2026-09-20) the subshell page's own header, where it replaced a status
 * badge. Both read the SHARED indicator precedence, so a subshell can never
 * say one thing in the rail and another above its own terminal.
 *
 * `data-status` and `data-alive` carry the raw fields beside the rendered
 * indicator. The two questions are genuinely different — the indicator is
 * what a person should see (working, waiting, unreachable), the raw pair is
 * what the server recorded — and the e2e suite asserts LIVENESS on the pair,
 * because neither raw field alone means it: `applyDeath` stamps
 * `alive: false` while leaving `status: "running"` (only operator-side acts
 * write "terminated"), so a dead-on-arrival pane reads
 * `status=running, alive=false` — the very row the specs exist to catch.
 * The pair also does not swing with the activity clock, which the visible
 * word does.
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
  // The bell REPLACES the dot while a delivered push goes unseen. The raw
  // data pair rides along: the e2e liveness assertions read this element in
  // either shape. No em dash in the label — the design-system copy rule.
  if (subshell.unseenPush) {
    const bellLabel = `unseen notification (${label})`;
    return (
      <span
        {...(accessible ? { role: "img", "aria-label": bellLabel } : { "aria-hidden": true })}
        title={bellLabel}
        data-status={subshell.status}
        data-alive={String(subshell.alive)}
        className={cn("mt-px shrink-0", className)}
      >
        <Bell size={12} className={BELL_TONE[indicator]} />
      </span>
    );
  }
  return (
    <span
      {...(accessible ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      title={label}
      data-status={subshell.status}
      data-alive={String(subshell.alive)}
      className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[indicator], className)}
    />
  );
}
