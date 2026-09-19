import type { SubshellView } from "@/types/subshell";

/**
 * Sectioning rules for the Subshells screen — the web grouping ported, not
 * re-invented: the predicate mirrors `apps/server/web/src/lib/subshell-order.ts:18-20`
 * and the buckets mirror `subshell-filter.ts:39-43` (spec §Testing: "mirroring
 * the tested lib/subshell-order.ts predicate"). The Waiting bucket is hoisted
 * out of Running here because the tab badge and the sections must agree on
 * one number.
 */

/** The exact fields {@link isWaiting} reads — accept any view that carries them. */
type WaitingProbe = Pick<SubshellView, "status" | "alive" | "waitingSince">;
/** The fields the lifecycle predicates read. */
type RowProbe = Pick<SubshellView, "status" | "alive">;

/** Alive with a live pane — the Running bucket, the poll's activity unit. */
export function isRunning(s: RowProbe): boolean {
  return s.status === "running" && s.alive;
}

/** status `running` but dead pane — crashed or paused mid-backoff. */
export function isExited(s: RowProbe): boolean {
  return s.status === "running" && !s.alive;
}

/** Operator-completed. */
export function isCompleted(s: Pick<SubshellView, "status">): boolean {
  return s.status === "terminated";
}

/**
 * True when the subshell's node is currently unreachable (spec 2026-08-31
 * §5.6). With no live node, `alive`/`waitingSince` are last-known facts, so
 * no waiting marker (section, chip, border, dot, badge) may assert them — the
 * web accessory rule (`nodeOffline` beats waiting, `subshell-card.tsx`) ported
 * to the shared predicate's call sites. `=== true` so older payloads without
 * the field read online-ish, never spuriously unreachable.
 */
export function isNodeOffline(subshell: Pick<SubshellView, "nodeOffline">): boolean {
  return subshell.nodeOffline === true;
}

/**
 * True when the subshell is alive and the attention watcher has stamped it as
 * waiting for the operator. The `status`/`alive` guards are deliberate (same
 * stale-stamp reasoning as the web predicate): a dead subshell is never
 * "waiting for you". Deliberately mirrors the web predicate, which knows
 * nothing about nodes — the offline suppression is applied at each marker
 * site (see {@link isNodeOffline}), exactly as the web gates it at the
 * accessory, not inside this predicate.
 */
export function isWaiting(subshell: WaitingProbe): boolean {
  return subshell.status === "running" && subshell.alive && subshell.waitingSince != null;
}

/** The four list sections, in render order. */
export interface SubshellSections {
  /** Alive and stamped — amber chip, badge source. */
  waiting: SubshellView[];
  /** Alive, not waiting. */
  running: SubshellView[];
  /** status `running` but dead pane — crashed or paused mid-backoff. */
  exited: SubshellView[];
  /** status `terminated` — operator-completed. */
  completed: SubshellView[];
}

/** Buckets a list into the four sections; input array untouched, order stable. */
export function sectionize(subshells: SubshellView[]): SubshellSections {
  // One pass; the buckets are exhaustive for the running|terminated union.
  const out: SubshellSections = { waiting: [], running: [], exited: [], completed: [] };
  for (const s of subshells) {
    if (isCompleted(s)) out.completed.push(s);
    else if (isExited(s)) out.exited.push(s);
    // Offline rows never join Waiting (web parity): the unreachable copy on
    // the card owns the row; its last-known `alive` groups it like Running.
    else if (!isNodeOffline(s) && isWaiting(s)) out.waiting.push(s);
    else if (isRunning(s)) out.running.push(s);
  }
  return out;
}

/**
 * Foreground fallback for the badge when `summary()` is unreachable (older
 * instance). Offline rows are excluded — same rule as {@link sectionize}, so
 * the badge and the Waiting section keep agreeing on one number.
 */
export function waitingCount(subshells: SubshellView[]): number {
  return subshells.filter((s) => !isNodeOffline(s) && isWaiting(s)).length;
}
