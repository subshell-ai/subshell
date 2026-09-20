import { isNetworkError } from "@internal/node-admin";
import { QueryClient } from "@tanstack/react-query";

/**
 * The node dashboard's shared query client — the same retry shape the control
 * plane's SPA carries, for a sharper reason here.
 *
 * This page is SERVED BY THE DAEMON. Any restart, update, or service stop
 * takes the process answering these fetches down with it, so a `NetworkError`
 * is not an edge case — it is the expected middle of the common flow. The
 * unbounded network retry is what makes the page self-heal the moment the
 * process is back: no "Try again" button to press after every act, and (the
 * same deliberate choice) no terminal error state to get stuck in. An HTTP
 * answer (the node is up and refused) still surfaces after one try — those are
 * real, actionable, and not a wait.
 */
export function queryRetry(failureCount: number, err: unknown): boolean {
  return isNetworkError(err) ? true : failureCount < 1;
}

/** Exponential backoff while the node is down, capped at 15 s with equal jitter. */
export function queryRetryDelay(attempt: number, err: unknown): number {
  if (!isNetworkError(err)) return 1000;
  const ceiling = Math.min(1000 * 2 ** attempt, 15_000);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: queryRetry,
      retryDelay: queryRetryDelay,
      refetchOnWindowFocus: false,
    },
  },
});
