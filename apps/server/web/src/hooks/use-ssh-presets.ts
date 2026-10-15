import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import type { SshPreset, SshPresetPayload } from "@/types/preset";

export const SSH_PRESETS_QUERY_KEY = [...PRESETS_QUERY_KEY, "ssh"] as const;

/** SSH choices never share the legacy agent-only cache entry. */
export function useSshPresets() {
  return useQuery({
    queryKey: SSH_PRESETS_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<SshPreset[]>("/api/presets?kind=ssh", { signal }),
  });
}

/** Create or edit only explicitly projected connection settings. */
export function useSaveSshPreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: string; payload: SshPresetPayload }) => {
      if (!id) return apiPost<SshPreset>("/api/presets", payload);
      const { kind: _kind, ...update } = payload;
      return apiFetch<SshPreset>(`/api/presets/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(update),
      });
    },
    onSuccess: (row) => {
      client.setQueryData<SshPreset[]>(SSH_PRESETS_QUERY_KEY, (rows) =>
        rows ? [...rows.filter((p) => p.id !== row.id), row] : [row],
      );
      void client.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
