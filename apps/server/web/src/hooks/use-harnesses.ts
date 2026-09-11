import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/hooks/use-nodes";
import { apiFetch } from "@/lib/api";
import type { HarnessInfo } from "@/types/harness";
import type { NodeHarness } from "@/types/node";

/** Shared key: the wizard, the profile editor and the per-node card agree. */
export const HARNESS_QUERY_KEY = ["harnesses"];

/**
 * The harness registry. The backend probes detection on every request, so a
 * re-check after installing a CLI is simply a refetch.
 */
export function useHarnesses(options: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: HARNESS_QUERY_KEY,
    queryFn: () => apiFetch<HarnessInfo[]>("/api/setup/harnesses"),
    // The Add an Agent screen passes ~4 s so an install made in a terminal
    // shows up without a control; every other caller omits it.
    refetchInterval: options.refetchInterval,
  });
}

/**
 * The harness rows of ONE node (spec 2026-08-31 §6.2/§9). No second endpoint
 * exists — the rows ride the node view (`GET /api/nodes/:id`), so this is a
 * typed read of that query, not a new fetch; the detail page and the harness
 * card share one cache entry.
 * @param nodeId - The node whose harness states to read
 */
export function useNodeHarnesses(nodeId: string) {
  const query = useNode(nodeId);
  return { ...query, harnesses: (query.data?.harnesses ?? []) as NodeHarness[] };
}

// `useSetNodePlugin` / `nodePluginErrorMessage` are gone with the route they
// POSTed to: plugins moved to the control plane (spec 2026-09-10), so the
// per-node install route no longer exists and `/settings/plugins` owns the
// verbs. The node page's card reports detection only.
