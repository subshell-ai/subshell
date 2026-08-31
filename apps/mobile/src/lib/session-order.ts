import type { SessionView } from "@/types/session";

/**
 * Sectioning rules for the Sessions screen — the web grouping ported, not
 * re-invented: the predicate mirrors `apps/frontend/src/lib/session-order.ts:18-20`
 * and the buckets mirror `session-filter.ts:39-43` (spec §Testing: "mirroring
 * the tested lib/session-order.ts predicate"). The Waiting bucket is hoisted
 * out of Running here because the tab badge and the sections must agree on
 * one number.
 */

/** The exact fields {@link isWaiting} reads — accept any view that carries them. */
type WaitingProbe = Pick<SessionView, "status" | "alive" | "waitingSince">;

/**
 * True when the session is alive and the attention watcher has stamped it as
 * waiting for the operator. The `status`/`alive` guards are deliberate (same
 * stale-stamp reasoning as the web predicate): a dead session is never
 * "waiting for you".
 */
export function isWaiting(session: WaitingProbe): boolean {
  return session.status === "running" && session.alive && session.waitingSince != null;
}

/** The four list sections, in render order. */
export interface SessionSections {
  /** Alive and stamped — amber chip, badge source. */
  waiting: SessionView[];
  /** Alive, not waiting. */
  running: SessionView[];
  /** status `running` but dead pane — crashed or paused mid-backoff. */
  exited: SessionView[];
  /** status `terminated` — operator-completed. */
  completed: SessionView[];
}

/** Buckets a list into the four sections; input array untouched, order stable. */
export function sectionize(sessions: SessionView[]): SessionSections {
  return {
    waiting: sessions.filter((s) => isWaiting(s)),
    running: sessions.filter((s) => s.status === "running" && s.alive && !isWaiting(s)),
    exited: sessions.filter((s) => s.status === "running" && !s.alive),
    completed: sessions.filter((s) => s.status === "terminated"),
  };
}

/** Foreground fallback for the badge when `summary()` is unreachable (older instance). */
export function waitingCount(sessions: SessionView[]): number {
  return sessions.filter(isWaiting).length;
}
