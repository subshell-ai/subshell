import type { SubshellView } from "@/types/subshell";

/** Explains the auto-restart column wherever it appears. */
export const AUTO_RESTART_HELP =
  "When a subshell's preset opts in, Subshell restarts the harness if its process exits, " +
  "waiting longer after each consecutive failure (30s, then 1m, 2m, 4m, 8m) and giving " +
  "up after 5 tries. The count resets once the subshell stays up.";

/** How many consecutive failures the server tries before giving up. */
export const AUTO_RESTART_MAX_TRIES = 5;

/**
 * The auto-restart state of a subshell, in words.
 *
 * The column this feeds used to be headed "Backoff" and print a bare number,
 * which named the retry algorithm rather than telling anyone what was
 * happening to their subshell.
 *
 * @param subshell - The subshell to describe
 * @param elapsed - Formats a timestamp as a rough distance from now
 * @returns A short phrase, or "—" when auto-restart has nothing to report
 */
export function describeAutoRestart(subshell: SubshellView, elapsed: (iso: string) => string): string {
  // A pending restart with no failures yet is the first attempt, already
  // scheduled — worth saying, since the subshell is down but on its way back.
  if (subshell.backoffCount === 0) return subshell.nextRestartAt ? "restarting…" : "—";

  const tries = `${subshell.backoffCount} ${subshell.backoffCount === 1 ? "retry" : "retries"}`;
  if (subshell.backoffCount >= AUTO_RESTART_MAX_TRIES) return `${tries} · gave up`;
  return subshell.nextRestartAt ? `${tries} · next in ${elapsed(subshell.nextRestartAt)}` : tries;
}
