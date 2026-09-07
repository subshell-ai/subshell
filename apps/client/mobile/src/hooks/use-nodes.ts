import { useQuery } from "@tanstack/react-query";
import { NODES_KEY } from "@/hooks/query-keys";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * Nodes for the launch picker (spec 2026-08-31 §9). Freshness is loose on
 * purpose — the online/offline projection can go stale between reads, and the
 * server's 409 NODE_OFFLINE at submit covers the race (same posture as the
 * web picker's list). An instance without the route 404s → `data` stays
 * undefined and the picker hides, so single-machine users see no change.
 */
export function useNodes() {
  const { client } = useSubshell();
  return useQuery({
    enabled: Boolean(client),
    queryKey: NODES_KEY,
    queryFn: () => client?.nodes(),
    staleTime: 30_000,
  });
}
