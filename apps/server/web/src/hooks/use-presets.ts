import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "@/lib/api";
import type { PresetPayload } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/** Query key for the caller's presets, shared by every mutation site. */
export const PRESETS_QUERY_KEY = ["presets"] as const;

/**
 * Shared query for the authenticated user's presets. Every page that lists
 * presets reads through this hook so a single `PRESETS_QUERY_KEY`
 * invalidation refreshes them all.
 *
 * The `?node=any` variant is gone with the node pin: the launch form now
 * asks for the AGENT first, and the default list's local-usability filter
 * agrees with the Agent picker's server-side greys, so there is no longer a
 * pairing the picker needs rows for that the list would hide.
 */
export function usePresets() {
  return useQuery({
    queryKey: PRESETS_QUERY_KEY,
    queryFn: () => apiFetch<PresetRow[]>("/api/presets"),
  });
}

/**
 * Invalidates the preset list. Keeps the key in one place the way
 * `use-workspaces` does, for every place presets are created or deleted.
 */
export function useInvalidatePresets(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
}

/**
 * Creates a preset (`POST /api/presets`, which returns the created row).
 * The caller decides what to do with the row — the launch dialog's inline
 * create selects it, the /presets page just lets the list render it.
 *
 * The row is WRITTEN INTO the list cache before the invalidation, not merely
 * invalidated behind it: the launch form selects the new row from this
 * response while its "preset must belong to the held agent" guard reads the
 * SAME cache, and an invalidation-only refetch would leave the row absent
 * long enough for the guard to null the selection back to "None".
 */
export function useCreatePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PresetPayload) => apiPost<PresetRow>("/api/presets", payload),
    onSuccess: (row) => {
      queryClient.setQueryData<PresetRow[]>(PRESETS_QUERY_KEY, (old) => (old ? [...old, row] : [row]));
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
