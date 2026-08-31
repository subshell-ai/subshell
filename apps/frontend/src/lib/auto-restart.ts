import type { SessionView } from "@/types/session";

/** Explains the auto-restart column wherever it appears. */
export const AUTO_RESTART_HELP =
  "When a session's profile opts in, Mote restarts the harness if its process exits, " +
  "waiting longer after each consecutive failure (30s, then 1m, 2m, 4m, 8m) and giving " +
  "up after 5 tries. The count resets once the session stays up.";

/** How many consecutive failures the server tries before giving up. */
export const AUTO_RESTART_MAX_TRIES = 5;

/**
 * The auto-restart state of a session, in words.
 *
 * The column this feeds used to be headed "Backoff" and print a bare number,
 * which named the retry algorithm rather than telling anyone what was
 * happening to their session.
 *
 * @param session - The session to describe
 * @param elapsed - Formats a timestamp as a rough distance from now
 * @returns A short phrase, or "—" when auto-restart has nothing to report
 */
export function describeAutoRestart(session: SessionView, elapsed: (iso: string) => string): string {
  // A pending restart with no failures yet is the first attempt, already
  // scheduled — worth saying, since the session is down but on its way back.
  if (session.backoffCount === 0) return session.nextRestartAt ? "restarting…" : "—";

  const tries = `${session.backoffCount} ${session.backoffCount === 1 ? "retry" : "retries"}`;
  if (session.backoffCount >= AUTO_RESTART_MAX_TRIES) return `${tries} · gave up`;
  return session.nextRestartAt ? `${tries} · next in ${elapsed(session.nextRestartAt)}` : tries;
}
