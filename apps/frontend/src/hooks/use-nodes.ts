import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY } from "@/lib/query-keys";
import type { CreatedSetupKey, Node, NodeDetail, SetupKeyRow } from "@/types/node";

/**
 * Node registry reads/writes (spec 2026-08-31 §9). All endpoints are
 * cookie-only in phase 1 and every failure arrives as an `ApiError` from
 * `apiFetch` — callers branch on `status`/`code` (e.g. the 409
 * NODE_RUNNING_SESSIONS delete guard).
 */

/** Key of the caller's setup-key list (`GET /api/nodes/setup-keys`). */
export const SETUP_KEYS_QUERY_KEY = ["node-setup-keys"] as const;

/**
 * The caller's visible nodes (owned or shared; the seeded `local` included).
 * @param polling - 3 s refetch while true (the add-node dialog sets this so
 *                  an enrolling node appears without a manual reload); false
 *                  restores ordinary stale-based refetching.
 */
export function useNodes({ polling = false }: { polling?: boolean } = {}) {
  return useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => apiFetch<{ nodes: Node[] }>("/api/nodes"),
    refetchInterval: polling ? 3000 : false,
  });
}

/** One node with its grant set (the key is absent for non-config-capable viewers). */
export function useNode(id: string, enabled = true) {
  return useQuery({
    queryKey: [...NODE_QUERY_KEY, id],
    queryFn: () => apiFetch<NodeDetail>(`/api/nodes/${id}`),
    enabled: enabled && id.length > 0,
  });
}

/**
 * Deletes (retires) a node — owner-only; the backend answers 409
 * NODE_RUNNING_SESSIONS while sessions run and refuses `local` outright.
 */
export function useDeleteNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ ok: boolean }>(`/api/nodes/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
    },
  });
}

/**
 * Asks an agent node for a fresh harness inventory (`POST /api/nodes/:id/recheck`).
 * The fresh snapshot is persisted server-side before the route answers, so a
 * success just invalidates the node view. Expected failures stay in the 409
 * family (`NODE_OFFLINE` / `NODE_UNREACHABLE`) — the caller shows the message;
 * `local` 400s (its probe is live on every read, so the UI never offers it).
 */
export function useRecheckNode(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/nodes/${id}/recheck`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
    },
  });
}

/** The caller's setup keys, newest first — usage state only, never the secret. */
export function useSetupKeys(enabled = true) {
  return useQuery({
    queryKey: SETUP_KEYS_QUERY_KEY,
    queryFn: () => apiFetch<{ keys: SetupKeyRow[] }>("/api/nodes/setup-keys"),
    enabled,
  });
}

/** Mints a single-use enrollment key; the plaintext is delivered once here. */
export function useCreateSetupKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      apiFetch<CreatedSetupKey>("/api/nodes/setup-keys", { method: "POST", body: JSON.stringify({ label }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETUP_KEYS_QUERY_KEY });
    },
  });
}

/** Revokes one of the caller's setup keys (a consumed row is deletable too). */
export function useDeleteSetupKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ ok: boolean }>(`/api/nodes/setup-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETUP_KEYS_QUERY_KEY });
    },
  });
}
