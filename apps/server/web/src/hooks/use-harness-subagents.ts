import { apiFetch } from "@internal/node-admin";
import type { HarnessSubagentSnapshot } from "@subshell-ai/plugin-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useHarnessSubagents(id: string, enabled = true) {
  return useQuery({
    queryKey: ["harness-subagents"],
    queryFn: () => apiFetch<Record<string, HarnessSubagentSnapshot>>("/api/subshells/subagents"),
    select: (states) => states[id],
    enabled: enabled && Boolean(id),
    refetchInterval: enabled ? 2000 : false,
    staleTime: 1000,
  });
}

export function useSelectHarnessAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string | null) =>
      apiFetch(`/api/subshells/${id}/subagents/select`, {
        method: "POST",
        body: JSON.stringify({ agentId }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["harness-subagents"] }),
  });
}
