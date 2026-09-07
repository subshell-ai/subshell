/** Full-jitter exponential backoff, base delay in ms (spec §7: 1 s → 60 s). */
export const BACKOFF_BASE_MS = 1_000;
/** Full-jitter exponential backoff, ceiling in ms (spec §7). */
export const BACKOFF_CAP_MS = 60_000;

/**
 * One reconnect delay, full-jitter exponential (spec §7):
 * `delay(attempt) = rand() * min(60_000, 1000 * 2**attempt)`.
 *
 * Pure and seeded: `rand` is injectable (the tests pin it to 0 for instant
 * reconnects and to 1/0.5 for determinism), so the function itself never
 * touches `Math.random` unless asked to. The exponential term is clamped by
 * `Math.min` — `2**30` (≈ 1.07e12 ms) and even `2**1024` (Infinity) both
 * clamp to the 60 s cap, so a very long outage cannot overflow into a
 * nonsensical wait.
 *
 * @param attempt - reconnect tries since the last successful open (0-based;
 *   negative values are floored to 0)
 * @param rand - source of jitter in [0, 1) (default `Math.random`)
 * @returns delay in milliseconds, always within `[0, min(cap, base * 2**attempt)]`
 */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const capped = 2 ** Math.max(0, attempt);
  return rand() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * capped);
}
