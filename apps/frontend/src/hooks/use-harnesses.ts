import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROFILES_QUERY_KEY } from "@/hooks/use-profiles";
import { ApiError, apiFetch } from "@/lib/api";
import type { HarnessInfo } from "@/types/harness";

/** Shared key: the settings page, the wizard and the profile editor agree. */
export const HARNESS_QUERY_KEY = ["harnesses"];

/**
 * The harness registry. The backend probes detection on every request, so a
 * re-check after installing a CLI is simply a refetch.
 */
export function useHarnesses() {
  return useQuery({
    queryKey: HARNESS_QUERY_KEY,
    queryFn: () => apiFetch<HarnessInfo[]>("/api/setup/harnesses"),
  });
}

/** Fresh detection without leaving the page (the "Re-check" button). */
export function useRecheckHarnesses() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
}

/**
 * Flips a harness's enabled state. Turning one on makes the server re-run
 * detection and 409 if the binary is missing — the toggle is the check.
 */
export function useSetHarnessEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<HarnessInfo>(`/api/setup/harnesses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
      // Enabling a harness has an invisible second effect server-side: it
      // seeds a Default profile for every user. Without this the profile
      // list/picker holds pre-enable data for the whole staleTime window,
      // making the auto-seeded profile look like it was never created.
      void queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
    },
  });
}

/** Turns an apiFetch failure into the message a harness card should show. */
export function harnessToggleErrorMessage(err: unknown): string {
  // The HTTP status, not its string rendering: ApiError carries it as a
  // number (lib/api.ts), so this survives message/format changes.
  if (err instanceof ApiError && err.status === 409)
    return "Not installed on this machine yet — install it, then re-check.";
  return "Could not change the harness state.";
}
