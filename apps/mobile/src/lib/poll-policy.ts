/**
 * The list-poll policy state machine (spec §Transport): "Foreground poll of
 * GET /api/sessions at 3 s while anything is running or waiting, 15 s when
 * quiescent, stopped in background, immediate on resume." Background wake-up
 * is push's job, not the poll's. Pure reducer — the AppState listener in
 * `hooks/use-foreground.ts` owns the clock, `hooks/polled-interval.ts` adapts
 * it for TanStack Query.
 */
import { isRunning } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

/** Interval while at least one session is alive. */
export const POLL_ACTIVE_MS = 3000;
/** Interval while quiescent. */
export const POLL_IDLE_MS = 15000;

/**
 * @param state - foreground (AppState active?) and hasActivity (any live session?)
 * @returns ms between polls, or null = do not poll (background)
 */
export function pollIntervalMs(state: { foreground: boolean; hasActivity: boolean }): number | null {
  if (!state.foreground) return null;
  return state.hasActivity ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/** Activity probe over the rows the poll returns. */
export function hasActivity(rows: readonly Pick<SessionView, "status" | "alive">[]): boolean {
  return rows.some(isRunning);
}
