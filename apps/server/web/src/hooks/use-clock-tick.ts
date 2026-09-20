import { useEffect, useState } from "react";

/**
 * Re-renders the caller on an interval, and stops on unmount.
 *
 * It exists because **activity is a function of elapsed time, not of a
 * message**. `computeActivity` is `now - lastOutputAt <= 60_000`, and with the
 * feed's 1.5 s cadence gone (spec 2026-09-19) nothing arrives to make a
 * subshell that simply went quiet re-render — it would sit on "active"
 * indefinitely, because no event describes the passage of time.
 *
 * ONE tick per surface that renders activity, never one per row: a hundred
 * cards share the page's single timer.
 *
 * @param intervalMs - how often to re-render
 */
export function useClockTick(intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}
