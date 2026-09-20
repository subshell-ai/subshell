import { isWaiting } from "@/lib/subshell-order";
import type { SubshellActivity, SubshellView } from "@/types/subshell";

/**
 * The six coarse states a subshell can be shown in, in the precedence the
 * home cards established (`accessoryFor` in subshell-card.tsx): node-offline
 * outranks everything — with the node down, `alive`/`waitingSince` are
 * last-known facts, not current state (spec 2026-08-31 §5.6); then `exited`;
 * then `waiting`; then activity, derived HERE from `lastOutputAt` rather than
 * taken from the server's `activity` field — see {@link deriveActivity}.
 *
 * Shared by the card's corner badge and the sidebar status dot (spec
 * 2026-09-03 sidebar-quickadd §1) so one subshell can never read as two
 * different states in two places.
 */
export type SubshellIndicator = "node-offline" | "exited" | "waiting" | "active" | "idle" | "terminated";

/** The exact fields the computation reads — mirrors `WaitingProbe`'s tolerance. */
type IndicatorProbe = Pick<
  SubshellView,
  "status" | "alive" | "activity" | "nodeOffline" | "waitingSince" | "lastOutputAt"
>;

/** How long after its last output a subshell still counts as working. */
export const ACTIVE_WINDOW_MS = 60_000;

/**
 * How often a surface rendering activity should re-evaluate it.
 *
 * A third of the window: the worst-case lag between a subshell going quiet
 * and the UI saying so is one tick, and 20 s of staleness on a coarse
 * working/idle badge is not something a person can see. Ticking at the window
 * itself would double the worst case.
 */
export const ACTIVITY_TICK_MS = 20_000;

/**
 * Active or idle, decided against the CLIENT's clock.
 *
 * The server computes the same thing at read time, and that used to be enough
 * because a frame arrived every 1.5 s. With the feed event-driven (spec
 * 2026-09-19) nothing arrives to mark the passage of time, so a subshell that
 * simply goes quiet would sit on "working" until something else happened to
 * it. Deriving it here — beside a `useClockTick` on whatever renders it — is
 * what makes going idle a thing the UI notices.
 *
 * Falls back to the server's own answer when `lastOutputAt` is absent, which
 * is what an older payload (or a row that has never produced output) carries.
 *
 * @param s - the subshell view
 * @param now - the clock, injectable for tests
 */
export function deriveActivity(s: IndicatorProbe, now: number = Date.now()): SubshellActivity {
  // `terminated` is a lifecycle fact, not an elapsed-time one — a clock can
  // never turn it back into "working".
  if (s.activity === "terminated") return "terminated";
  if (!s.lastOutputAt) return s.activity;
  const last = new Date(s.lastOutputAt).getTime();
  if (Number.isNaN(last)) return s.activity;
  return now - last <= ACTIVE_WINDOW_MS ? "active" : "idle";
}

/** The indicator for one subshell view (see {@link SubshellIndicator} for the precedence). */
export function subshellIndicator(s: IndicatorProbe): SubshellIndicator {
  // `=== true` matches the card's posture: older payloads without the field
  // read online-ish.
  if (s.nodeOffline === true) return "node-offline";
  if (s.status === "running" && !s.alive) return "exited";
  if (isWaiting(s)) return "waiting";
  return deriveActivity(s);
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

/**
 * Status ordering for lists that sort by liveness (the sidebar's recents):
 * who might need me first, what's moving next, the merely-quiet, then the
 * unknowable (node down — possibly still working there), then the dead, with
 * ended last. `node-offline` sits BELOW `idle` on purpose: a live-and-quiet
 * subshell is a known state you can act on; an unreachable one is not.
 */
const STATUS_RANK: Record<SubshellIndicator, number> = {
  waiting: 0,
  active: 1,
  idle: 2,
  "node-offline": 3,
  exited: 4,
  terminated: 5,
};

/**
 * One subshell's position in the status band order (see {@link STATUS_RANK}) —
 * lower is more urgent.
 *
 * Exported so the sidebar's node grouping can rank a GROUP by its liveliest
 * member without re-deriving the table: a machine with something waiting for
 * you has to sort above a machine with nothing but ended sessions, and that
 * has to mean the same thing there as it does in {@link sortByStatus}.
 */
export function subshellStatusRank(s: IndicatorProbe): number {
  return STATUS_RANK[subshellIndicator(s)];
}

/**
 * The list ordered by status band (see {@link STATUS_RANK}), preserving the
 * input order inside each band — callers keep their own recency sort as the
 * tie-break (`Array.prototype.sort` is stable). Returns a copy.
 */
export function sortByStatus<T extends IndicatorProbe & { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => STATUS_RANK[subshellIndicator(a)] - STATUS_RANK[subshellIndicator(b)]);
}
