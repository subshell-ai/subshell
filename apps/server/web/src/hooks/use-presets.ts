import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "@/lib/api";
import type { PresetPayload } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/** Query key for the caller's presets, shared by every mutation site. */
export const PRESETS_QUERY_KEY = ["presets"] as const;

/**
 * Shared query for the authenticated user's presets. Every page that lists
 * presets reads through this hook so a single `PRESETS_QUERY_KEY`
 * invalidation refreshes them all (prefix match covers the `node=any`
 * variant's key too).
 *
 * The default list filters rows against the CONTROL PLANE's own probe
 * (`usableHarnessIds()`), while the launch form enables agents from the
 * SELECTED node's inventory. Those two agree only when the picked machine IS
 * the control-plane host: on a host without the agent's CLI and a node with
 * it, the filtered list would hide every preset of a selectable agent — the
 * form reads "No presets for Claude Code yet." while that node runs them
 * fine. The launch form therefore asks for `"any"`; every other surface
 * (`/presets`, the detail/action lookups) is control-plane-local and correct
 * on the filtered list (spec 2026-09-13 §5).
 * @param opts.node - `"any"` lists presets regardless of LOCAL harness
 *   state (launch-form only). Default: the local filter.
 */
export function usePresets(opts: { node?: "any" } = {}) {
  // One local so the cache-key segment and the wire string can never drift.
  const node = opts.node;
  return useQuery({
    queryKey: node === undefined ? PRESETS_QUERY_KEY : ([...PRESETS_QUERY_KEY, "node", node] as const),
    queryFn: () => apiFetch<PresetRow[]>(node === undefined ? "/api/presets" : `/api/presets?node=${node}`),
  });
}

/**
 * Invalidates the preset list. Keeps the key in one place the way
 * `use-workspaces` does, for every place presets are created or deleted.
 * The `PRESETS_QUERY_KEY` prefix match covers the `["presets","node","any"]`
 * variant too — both lists refetch on one call.
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
 * The row is WRITTEN INTO the list caches before the invalidation, not merely
 * invalidated behind it: the launch form selects the new row from this
 * response while its "preset must belong to the held agent" guard reads the
 * SAME cache, and an invalidation-only refetch would leave the row absent
 * long enough for the guard to null the selection back to "None". BOTH key
 * spellings are written for that reason — the launch form reads the
 * `node=any` variant, and a write only to the default key would be the same
 * round trip by another route.
 */
export function useCreatePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PresetPayload) => apiPost<PresetRow>("/api/presets", payload),
    onSuccess: (row) => {
      const keys = [PRESETS_QUERY_KEY, [...PRESETS_QUERY_KEY, "node", "any"] as const] as const;
      for (const key of keys) {
        queryClient.setQueryData<PresetRow[]>(key, (old) => (old ? [...old, row] : [row]));
      }
      void queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
