import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { CreatedSetupKey, Node, NodeDetail, RotatedNodeKey, SetupKeyRow } from "@/types/node";

/**
 * Node registry reads/writes (spec 2026-08-31 §9). All endpoints are
 * cookie-only and every failure arrives as an `ApiError` from `apiFetch` —
 * callers branch on `status`/`code` (e.g. the 409 NODE_RUNNING_SUBSHELLS
 * delete guard, the 409 NODE_NAME_TAKEN rename collision).
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
 * NODE_RUNNING_SUBSHELLS while subshells run and refuses `local` outright.
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
 * A success means the server attests the agent ACKNOWLEDGED the command — the
 * fresh snapshot lands asynchronously via the inventory event, so the
 * invalidation here may refetch the previous inventory; a later refetch picks
 * up the new one. Expected failures stay in the 409 family (`NODE_OFFLINE` /
 * `NODE_UNREACHABLE`) — the caller shows the message; `local` 400s (its probe
 * is live on every read, so the UI never offers it).
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

/**
 * Renames a node (`PATCH /api/nodes/:id` `{name}`) — OWNER-only server-side
 * (an admin's effective edit does not extend to renaming a foreign agent) and
 * the `local` node's name is fixed for everyone (400). A per-owner name
 * collision answers 409 `NODE_NAME_TAKEN` with the server's own message.
 * The response is a plain NodeView; the detail cache is INVALIDATED rather
 * than written through because the detail row also carries `shares`, which
 * the PATCH response omits.
 */
export function useRenameNode(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<Node>(`/api/nodes/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
    },
  });
}

/**
 * Rotates a node's bearer key (`POST /api/nodes/:id/rotate-key`) — manager-
 * only cookie call. The plaintext arrives ONCE in this response (only its
 * hash is stored); the caller shows it once and forgets it. The old key is
 * disabled and a live agent socket is evicted, so the node drops offline
 * until the operator re-configures the agent with the new key — the response
 * `message` carries that guidance verbatim.
 */
export function useRotateNodeKey(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<RotatedNodeKey>(`/api/nodes/${id}/rotate-key`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      // Cross-domain (the useCreateSubshell pattern): the eviction drops the
      // agent, which flips every subshell on this node to `nodeOffline` — the
      // subshell list must learn that now, not on its next incidental refetch.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
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

/**
 * Replaces a node's directory allowlist — the complete set, never a delta.
 *
 * OWNER-only server-side (`canManage`); the card hides the controls for
 * everyone else, but the server is the gate. An empty array CLEARS the rules
 * and returns the node to unrestricted.
 */
export function useSetNodeAllowedDirs(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dirs: string[]) =>
      apiFetch<NodeDetail>(`/api/nodes/${id}/allowed-dirs`, {
        method: "PUT",
        body: JSON.stringify({ dirs }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      // The folder picker's listings are scoped by these rules, so a change
      // makes every cached explore response stale.
      void queryClient.invalidateQueries({ queryKey: ["explore"] });
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });
}
