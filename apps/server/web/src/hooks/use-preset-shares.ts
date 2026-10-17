import { apiFetch } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import type { ShareDraft, SubshellShare } from "@/hooks/use-subshell-shares";

const key = (id: string) => ["preset-shares", id] as const;
export function usePresetShares(id: string, enabled: boolean) {
  return useQuery({
    queryKey: key(id),
    queryFn: () => apiFetch<{ shares: SubshellShare[] }>(`/api/presets/${encodeURIComponent(id)}/shares`),
    enabled,
  });
}
export function useSetPresetShares(id: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (shares: ShareDraft[]) =>
      apiFetch<{ shares: SubshellShare[] }>(`/api/presets/${encodeURIComponent(id)}/shares`, {
        method: "PUT",
        body: JSON.stringify({ shares }),
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: key(id) });
      void cache.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
    },
  });
}
