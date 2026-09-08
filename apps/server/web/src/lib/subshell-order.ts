import type { SubshellView } from "@/types/subshell";
import type { WorkspacePaneRow } from "@/types/workspace";

/** The exact fields {@link isWaiting} reads — accept any view that carries them. */
type WaitingProbe = Pick<SubshellView, "status" | "alive" | "waitingSince">;

/**
 * True when the subshell is alive and the attention watcher has stamped it as
 * waiting for the operator (a finished turn or an approval prompt).
 *
 * The `status`/`alive` guards are deliberate: the watcher clears
 * `waitingSince` on resume and death, but a view fetched at the wrong moment
 * can still carry a stale stamp — a dead subshell is never "waiting for you".
 *
 * Takes the three-field probe rather than a full `SubshellView` so
 * {@link isPaneWaiting} can reuse this single predicate instead of forking it.
 */
export function isWaiting(subshell: WaitingProbe): boolean {
  return subshell.status === "running" && subshell.alive && subshell.waitingSince != null;
}

/**
 * The workspace-pane form of {@link isWaiting}: a `WorkspacePaneRow` carries
 * its subshell's summary under flat field names (`subshellStatus`,
 * `subshellAlive`, `subshellWaitingSince`), so it maps them onto the probe and
 * defers — the dock tab must agree with the chip everywhere else.
 */
export function isPaneWaiting(pane: WorkspacePaneRow): boolean {
  return isWaiting({
    status: pane.subshellStatus,
    alive: pane.subshellAlive,
    waitingSince: pane.subshellWaitingSince,
  });
}

/** Rank 0 = bell-on and waiting; rank 1 = everything else. */
function priorityRank(subshell: SubshellView): number {
  return subshell.notify && isWaiting(subshell) ? 0 : 1;
}

/**
 * Reorders the running bucket so subshells waiting for the operator (with
 * their bell on) come first.
 *
 * The comparator only ever returns the difference between two buckets, and
 * `Array.prototype.sort` is stable, so every subshell keeps its relative
 * order inside its bucket. Returns a copy — the input array is untouched.
 */
export function priorityRunning(subshells: SubshellView[]): SubshellView[] {
  return [...subshells].sort((a, b) => priorityRank(a) - priorityRank(b));
}

/** The fields {@link sortByCreation} reads. */
type CreationProbe = { id: string; createdAt: string };

/**
 * Newest-created first, with the id as a total tie-break.
 *
 * This is the order the prev/next SWIPE walks, and it is deliberately NOT
 * {@link import("./subshell-indicator.js").sortByStatus} — the one the sidebar
 * uses. That order ranks by `subshellIndicator`, which returns `activity`,
 * and activity is "produced output within the last 60s". It is exactly right
 * for a list you READ: the subshell that just did something rises to the top.
 * It is wrong for something you NAVIGATE, because the order changes on its
 * own: swipe left twice expecting to walk a list and the list has reshuffled
 * underneath you, because some other agent happened to print a line. On a
 * phone, where the swipe IS the navigation, that reads as the app moving
 * things behind your back. (It also made e2e spec 09 flaky, which is how it
 * was found.)
 *
 * `createdAt`, not `startedAt`: a restart re-stamps `startedAt`, and reviving
 * a subshell must not move it in the order.
 *
 * @param list - Subshells in any order
 * @returns A new array, newest first
 */
export function sortByCreation<T extends CreationProbe>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
    // Same millisecond (or an unparseable stamp): fall back to something
    // total, so the order is still deterministic rather than input-dependent.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
