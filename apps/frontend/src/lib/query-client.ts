import { QueryClient } from "@tanstack/react-query";
import { isNetworkError } from "@/lib/api";

/** Cap on network-error retries: ~60 capped-backoff attempts ride out a
 * ~15-minute outage; past that the operator needs more than a retry loop. */
const NETWORK_RETRY_MAX = 60;

/**
 * Query retry rule: a DOWN server (`NetworkError`) retries until the cap so
 * every screen self-heals when the server returns — no manual "Try again".
 * An HTTP answer (the server is up and said no) keeps the historical
 * single-retry behavior so auth failures and 404s still surface fast.
 */
export function queryRetry(failureCount: number, err: unknown): boolean {
  return isNetworkError(err) ? failureCount < NETWORK_RETRY_MAX : failureCount < 1;
}

/** Exponential backoff capped at 15 s while the server is unreachable;
 * HTTP retries keep the default first-retry delay (1 s). */
export function queryRetryDelay(attempt: number, err: unknown): number {
  return isNetworkError(err) ? Math.min(1000 * 2 ** attempt, 15_000) : 1000;
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
