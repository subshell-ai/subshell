import type { SessionView } from "@/types/session";
import type { WorkspacePaneRow } from "@/types/workspace";

/** The exact fields {@link isWaiting} reads — accept any view that carries them. */
type WaitingProbe = Pick<SessionView, "status" | "alive" | "waitingSince">;

/**
 * True when the session is alive and the attention watcher has stamped it as
 * waiting for the operator (a finished turn or an approval prompt).
 *
 * The `status`/`alive` guards are deliberate: the watcher clears
 * `waitingSince` on resume and death, but a view fetched at the wrong moment
 * can still carry a stale stamp — a dead session is never "waiting for you".
 *
 * Takes the three-field probe rather than a full `SessionView` so
 * {@link isPaneWaiting} can reuse this single predicate instead of forking it.
 */
export function isWaiting(session: WaitingProbe): boolean {
  return session.status === "running" && session.alive && session.waitingSince != null;
}

/**
 * The workspace-pane form of {@link isWaiting}: a `WorkspacePaneRow` carries
 * its session's summary under flat field names (`sessionStatus`,
 * `sessionAlive`, `sessionWaitingSince`), so it maps them onto the probe and
 * defers — the dock tab must agree with the chip everywhere else.
 */
export function isPaneWaiting(pane: WorkspacePaneRow): boolean {
  return isWaiting({
    status: pane.sessionStatus,
    alive: pane.sessionAlive,
    waitingSince: pane.sessionWaitingSince,
  });
}

/** Rank 0 = bell-on and waiting; rank 1 = everything else. */
function priorityRank(session: SessionView): number {
  return session.notify && isWaiting(session) ? 0 : 1;
}

/**
 * Reorders the running bucket so sessions waiting for the operator (with
 * their bell on) come first.
 *
 * The comparator only ever returns the difference between two buckets, and
 * `Array.prototype.sort` is stable, so every session keeps its relative
 * order inside its bucket. Returns a copy — the input array is untouched.
 */
export function priorityRunning(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) => priorityRank(a) - priorityRank(b));
}
