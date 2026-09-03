import { isWaiting } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The six coarse states a subshell can be shown in, in the precedence the
 * home cards established (`accessoryFor` in subshell-card.tsx): node-offline
 * outranks everything — with the agent down, `alive`/`waitingSince` are
 * last-known facts, not current state (spec 2026-08-31 §5.6); then `exited`;
 * then `waiting`; then the server's `activity`.
 *
 * Shared by the card's corner badge and the sidebar status dot (spec
 * 2026-09-03 sidebar-quickadd §1) so one subshell can never read as two
 * different states in two places.
 */
export type SubshellIndicator = "node-offline" | "exited" | "waiting" | "active" | "idle" | "terminated";

/** The exact fields the computation reads — mirrors `WaitingProbe`'s tolerance. */
type IndicatorProbe = Pick<SubshellView, "status" | "alive" | "activity" | "nodeOffline" | "waitingSince">;

/** The indicator for one subshell view (see {@link SubshellIndicator} for the precedence). */
export function subshellIndicator(s: IndicatorProbe): SubshellIndicator {
  // `=== true` matches the card's posture: older payloads without the field
  // read online-ish.
  if (s.nodeOffline === true) return "node-offline";
  if (s.status === "running" && !s.alive) return "exited";
  if (isWaiting(s)) return "waiting";
  return s.activity;
}

/** The word for each state — the exact copy the home cards already use. */
export const INDICATOR_LABEL: Record<SubshellIndicator, string> = {
  "node-offline": "node unreachable",
  exited: "exited",
  waiting: "waiting for you",
  active: "working",
  idle: "idle",
  terminated: "ended",
};

/** The Badge variant each state maps to on the card (the waiting arm renders `WaitingChip`, not a Badge). */
export const INDICATOR_VARIANT: Record<SubshellIndicator, "success" | "warning" | "muted"> = {
  "node-offline": "warning",
  exited: "muted",
  waiting: "warning",
  active: "success",
  idle: "warning",
  terminated: "muted",
};
