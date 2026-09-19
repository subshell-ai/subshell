import { isNetworkError } from "@internal/node-admin";
import { QueryClient } from "@tanstack/react-query";

/**
 * Query retry rule: a DOWN server (`NetworkError`) retries UNBOUNDED so every
 * screen self-heals the moment the server returns — no manual "Try again", and
 * (deliberately) no final "error" state to get stuck in after a long outage.
 * The `OfflineBanner` explains the wait; the capped backoff below keeps it to
 * ≤1 attempt / 15 s. An HTTP answer (the server is up and said no) keeps the
 * historical single-retry behavior so auth failures and 404s surface fast —
 * those still reach a real error state and are NOT retried forever.
 */
export function queryRetry(_failureCount: number, err: unknown): boolean {
  return isNetworkError(err) ? true : _failureCount < 1;
}

/**
 * Backoff while the server is unreachable: exponential capped at 15 s, with
 * equal jitter (half fixed, half uniform) so queries that all failed on the
 * same outage retry staggered — not in a lockstep herd hammering the first
 * moment the server is back. HTTP retries keep the default 1 s.
 */
export function queryRetryDelay(attempt: number, err: unknown): number {
  if (!isNetworkError(err)) return 1000;
  const ceiling = Math.min(1000 * 2 ** attempt, 15_000);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * Shared React Query client. HTTP errors surface quickly (see
 * {@link queryRetry}); only a server that is DOWN keeps retrying, driven
 * visible by the OfflineBanner. Mutations do NOT retry — a lifecycle click
 * into the void fails visibly and the user re-fires it once the banner clears.
 */
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
