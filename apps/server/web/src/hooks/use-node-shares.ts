import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY, NODE_SHARES_QUERY_KEY, NODES_QUERY_KEY } from "@/lib/query-keys";
import type { NodeShare } from "@/types/node";

/**
 * Sharing reads/writes for one node (spec 2026-08-31 §9/§10) — the mirror of
 * `use-subshell-shares`: `granteeUserId` null is the "Everyone" grant, and the
 * PUT replaces the whole set. Both routes are MANAGER-only (owner, or admin on
 * `local`) — an `edit` grantee may configure the node but never reads or moves
 * the grant list, so callers gate both on `Node.canManage` (server-derived;
 * the frontend must not re-derive admin identity).
 */

/** GETs a node's current grants. Managers only (everyone else gets 403/404). */
export function useNodeShares(id: string, enabled = true) {
  return useQuery({
    queryKey: [...NODE_SHARES_QUERY_KEY, id],
    queryFn: () => apiFetch<{ shares: NodeShare[] }>(`/api/nodes/${id}/shares`),
    enabled: enabled && id.length > 0,
  });
}

/**
 * PUTs the whole grant set (a grant not present in `shares` is removed). On
 * success the shares query, the node detail (its `shares` field) and the list
 * (access badges) all refresh.
 */
export function useSetNodeShares(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shares: Pick<NodeShare, "granteeUserId" | "permission">[]) =>
      apiFetch<{ shares: NodeShare[] }>(`/api/nodes/${id}/shares`, {
        method: "PUT",
        body: JSON.stringify({ shares }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_SHARES_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
    },
  });
}
