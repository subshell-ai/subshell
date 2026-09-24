import {
  apiFetch,
  type CreatedSetupKey,
  NODE_QUERY_KEY,
  NODES_QUERY_KEY,
  type Node,
  type RotatedNodeKey,
  type SetupKeyRow,
} from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/**
 * The PLANE-only half of the node registry (spec 2026-08-31 §9): the list,
 * the enrollment keys, and the acts that belong to owning a node inside an
 * instance (delete, rename, rotate). The per-node detail read and every verb
 * the shared node-admin cards speak moved to `@internal/node-admin` with them
 * — two backends answer that contract now, and only the control plane answers
 * this half.
 *
 * All endpoints are cookie-only and every failure arrives as an `ApiError`
 * from `apiFetch` — callers branch on `status`/`code` (e.g. the 409
 * NODE_RUNNING_SUBSHELLS delete guard, the 409 NODE_NAME_TAKEN rename
 * collision).
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
 * A success means the server attests the node ACKNOWLEDGED the command — the
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
 * disabled and a live node socket is evicted, so the node drops offline
 * until the operator re-configures that machine with the new key — the response
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
      // node, which flips every subshell on this node to `nodeOffline` — the
      // subshell list must learn that now, not on its next incidental refetch.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
    },
  });
}

/** The caller's setup keys, newest first — each with its key text, which is what the card lists. */
export function useSetupKeys(enabled = true) {
  return useQuery({
    queryKey: SETUP_KEYS_QUERY_KEY,
    queryFn: () => apiFetch<{ keys: SetupKeyRow[] }>("/api/nodes/setup-keys"),
    enabled,
  });
}

/** What the admin `?all=1` read adds to each row: whose key it is. */
export interface SetupKeyOwnerFields {
  /** Creator's user id */
  ownerUserId: string;
  /** Creator's display name, falling back to email, then to the raw id for a deleted account */
  ownerLabel: string;
}

/** One row of the admin instance-wide listing. */
export type AllSetupKeyRow = SetupKeyRow & SetupKeyOwnerFields;

/**
 * EVERY setup key in the instance (audit 2026-09 item 4) — a cookie-admin
 * read. A plain user gets 403 from the route, so callers gate the switch on
 * `viewerIsAdmin` and keep this `enabled` until someone asks for it.
 *
 * The key sits BELOW `SETUP_KEYS_QUERY_KEY`, so the revoke mutation's prefix
 * invalidation refreshes both shapes at once and neither list can lag the
 * other.
 */
export function useAllSetupKeys(enabled: boolean) {
  return useQuery({
    queryKey: [...SETUP_KEYS_QUERY_KEY, "all"] as const,
    queryFn: () => apiFetch<{ keys: AllSetupKeyRow[] }>("/api/nodes/setup-keys?all=1"),
    enabled,
  });
}

/**
 * Mints a single-use enrollment key. No argument and no body: the key names
 * nothing, because a node is named by the machine that becomes it.
 */
export function useCreateSetupKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<CreatedSetupKey>("/api/nodes/setup-keys", { method: "POST" }),
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
