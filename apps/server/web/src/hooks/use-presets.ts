import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PresetPayload } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/** Query key for the caller's presets, shared by every mutation site. */
export const PRESETS_QUERY_KEY = ["presets"] as const;

/**
 * Shared query for the authenticated user's presets. One key, one URL: every
 * surface — the launch form, `/presets`, the clone dialog, the detail/action
 * lookups — reads the SAME list, because availability is decided by the
 * SERVER against the instance plugin store (installed ∧ enabled ∧ ¬broken),
 * not against any machine's PATH (spec 2026-09-13 follow-up). Per-node
 * compatibility is the picker's grey matrix, client-side — it filters what a
 * listed preset may LAUNCH on, never whether it is listed. The `node=any`
 * era is over: that variant existed to escape a local filter that no longer
 * exists, and its cache key escaped the invalidation with it.
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
 * Toggles a preset's enabled flag (`PATCH /api/presets/:id`, cookie-only,
 * which returns the updated row). Works for both kinds: the SSH rows live
 * under the same `["presets"]` prefix, so one invalidation refreshes the
 * agent list and the `["presets", "ssh"]` list at once.
 */
export function useTogglePresetEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/presets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      // `["presets"]` is a PREFIX match, so this invalidates both the agent
      // list and the `["presets", "ssh"]` list in one call.
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
    onError: () => {
      // Without this a refused PATCH is silent: the switch snaps back when the
      // list refetches and the person never learns why.
      toast.error("Couldn't update the preset. It's unchanged; try again.");
    },
  });
}

/**
 * Creates a preset (`POST /api/presets`, which returns the created row) and
 * hands the row to the caller - the /presets page lets the list render it,
 * and the launch form's "Save as preset" path posts through the launch
 * mutation instead of this hook.
 *
 * The row is WRITTEN INTO the list cache before the invalidation, not merely
 * invalidated behind it: a surface that just created a preset and reads the
 * same `["presets"]` cache (a picker opened straight after, the edit
 * landing) would otherwise see the row absent for a frame.
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
