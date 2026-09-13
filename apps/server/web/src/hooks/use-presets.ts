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
 * Invalidates the list on success; the caller decides what to do with the
 * row — the launch dialog's inline create selects it, the /presets page
 * just lets the invalidation render it.
 */
export function useCreatePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PresetPayload) => apiPost<PresetRow>("/api/presets", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
