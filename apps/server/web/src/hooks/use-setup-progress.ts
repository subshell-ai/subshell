import { apiFetch } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SETUP_PROGRESS_QUERY_KEY } from "@/lib/query-keys";
import type { SetupProgress, SetupStep } from "@/types/setup";

/**
 * The caller's wizard bookmark (spec 2026-09-16).
 *
 * @param enabled - pass `!!user`: a bookmark presupposes a user, and the
 * route answers an anonymous caller with 401 (there is no no-users carve-out
 * here, unlike the harness routes).
 */
export function useSetupProgress(enabled: boolean) {
  return useQuery({
    queryKey: SETUP_PROGRESS_QUERY_KEY,
    queryFn: () => apiFetch<SetupProgress>("/api/setup/progress"),
    enabled,
    // Read once per document: the wizard's writes are the only thing that
    // changes this, and they write the cache through the mutation below.
    staleTime: Infinity,
  });
}

/**
 * Writes the caller's own bookmark.
 *
 * Fire-and-forget with an optimistic cache update: the shell reads the SAME
 * key the moment a step transition re-renders it, and without the optimistic
 * write the just-advanced bookmark would still look like the old one — a
 * `null` on finish leaving the resume redirect armed underneath the
 * navigation to the dashboard. A failed PATCH costs a resume at the previous
 * step, which is the harmless direction, so the failure is not surfaced.
 */
export function useSetSetupProgress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (step: SetupStep | null) =>
      apiFetch<SetupProgress>("/api/setup/progress", { method: "PATCH", body: JSON.stringify({ step }) }),
    onMutate: (step) => {
      queryClient.setQueryData<SetupProgress>(SETUP_PROGRESS_QUERY_KEY, { step });
    },
  });
}
