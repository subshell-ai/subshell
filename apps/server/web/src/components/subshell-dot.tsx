import { cn } from "@internal/node-admin";
import { Bell } from "lucide-react";
import { INDICATOR_LABEL, type SubshellIndicator, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * Fill classes per state, in the rail's own visual language (spec
 * 2026-09-03 sidebar-quickadd §1 note): tone is a sidebar concern, so this
 * table lives with the dot, not in the shared indicator module.
 *
 * GREEN is the ALIVE family (2026-09-24, operator call): full green is
 * printing, dim green is quiet-but-running. Idle used to be neutral gray,
 * which read as "off" — a mid-tool-call agent with a 60s silence looked dead
 * beside things that are. The pair's difference is MOTION, not brightness
 * alone (same-day operator ask): ACTIVE carries the hard on/off blink
 * defined in `styles.css` (`subshell-dot-blink`, "like Claude Code's
 * in-progress work") — a loop, which is only honest on a node that
 * structurally never remounts — and under `prefers-reduced-motion` the loop
 * does not exist and the dot is plain green. Every other state, and the
 * bell, is still.
 *
 * The two dead states stay readable at 6px by shape and faintness, not just
 * hue — `exited` is a faint GRAY fill (gray is not alive), `terminated` a
 * hollow ring.
 *
 * `node-offline` is the palette's RED (2026-09-24, operator call: it read as
 * too gentle as an orange): a machine you cannot reach is an error state, not
 * a caution, and it now outranks `waiting`'s amber on the colour scale.
 */
const DOT_CLASS: Record<SubshellIndicator, string> = {
  // The blink class is CSS-gated on `prefers-reduced-motion: no-preference`
  // (see styles.css); naming it here unconditionally is safe — under reduce
  // the class carries nothing.
  active: "bg-success subshell-dot-blink",
  idle: "bg-success/50",
  waiting: "bg-warning",
  exited: "bg-muted-foreground/50",
  terminated: "border border-muted-foreground",
  "node-offline": "bg-destructive",
};

/**
 * Bell tone per state (spec 2026-09-23): the glyph says "pushed and you have
 * not looked", the colour keeps saying what the dot said. Spelled apart from
 * DOT_CLASS on purpose — those are background fills, an icon colors by
 * `text-*`.
 */
const BELL_TONE: Record<SubshellIndicator, string> = {
  active: "text-success",
  idle: "text-success/50",
  waiting: "text-warning",
  exited: "text-muted-foreground/50",
  terminated: "text-muted-foreground",
  "node-offline": "text-destructive",
};

/**
 * The 6px state dot for one subshell — the rail's recent rows, the subshell
 * page's own header (2026-09-20, where it replaced a status badge), and since
 * 2026-09-24 the home cards' corner and the list rows' name cell (where it
 * replaced the text chips). All read the SHARED indicator precedence, so a
 * subshell can never say one thing in the rail and another above its own
 * terminal. Surfaces beyond the rail pass `mt-0` — the default margin aligns
 * the dot with the FIRST text line of the rail's two-line rows; standalone
 * dots center against their row's own `items-center`.
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
  // The bell REPLACES the dot while a delivered push goes unseen — for its
  // OWNER only. Every clear site (pane open, log tail, attach) requires the
  // owner's cookie, so a bell on a shared pane would be owner notification
  // state rendered as grantee state: a mark that can never clear from this
  // seat. `access` is the client's own per-viewer stamp (the live feed carries
  // none) — this is the layer that knows it. The raw data pair rides along:
  // the e2e liveness assertions read this element in either shape. No em dash
  // in the label — the design-system copy rule.
  if (subshell.unseenPush && subshell.access === "owner") {
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
