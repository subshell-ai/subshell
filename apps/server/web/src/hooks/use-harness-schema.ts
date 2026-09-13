import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { HarnessSchema } from "@/types/harness";

/**
 * Reference data (settings schema + env/flag suggestions) for one harness,
 * backing the preset editor's autocomplete. inert until a harness is picked;
 * switching harnesses re-keys the query.
 */
export function useHarnessSchema(harnessId: string) {
  return useQuery({
    queryKey: ["harness-schema", harnessId],
    queryFn: () => apiFetch<HarnessSchema>(`/api/presets/harnesses/${harnessId}/schema`),
    enabled: harnessId !== "",
    staleTime: 5 * 60 * 1000,
  });
}
