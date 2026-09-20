/**
 * Compact relative time (e.g. "5m", "2h", "3d").
 *
 * No seconds: the SSE feed re-renders these lists on every tick, and a
 * second-by-second value would churn without telling anyone anything.
 *
 * Moved out of the SPA's `components/subshell-status.tsx` with the node cards,
 * which stamp "in maintenance since …" with it; the subshell surfaces import
 * it back from here rather than keeping a second copy.
 */
export function relativeElapsed(iso: string): string {
  const ms = Date.parse(iso);
  const secs = Math.abs(Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
