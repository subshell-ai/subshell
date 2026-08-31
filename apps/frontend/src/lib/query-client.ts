import { QueryClient } from "@tanstack/react-query";

/**
 * Shared React Query client. Retries are kept minimal so API errors surface
 * quickly in the UI (auth failures, harness not installed, etc.).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
