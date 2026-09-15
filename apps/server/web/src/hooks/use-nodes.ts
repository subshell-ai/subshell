import type { NodeServiceVerb } from "@internal/subshell-protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { CreatedSetupKey, MaintenanceResult, Node, NodeDetail, RotatedNodeKey, SetupKeyRow } from "@/types/node";

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

/**
 * One node with its grant set (the key is absent for non-config-capable viewers).
 *
 * **Polled, at the Service page's own cadence**, because the most important
 * thing this view reports is the one thing no action on this page causes: the
 * node GOING OFFLINE. Without it the page kept a full runtime card — pid,
 * uptime, every Service verb enabled — on a machine that had dropped its
 * socket minutes ago, until someone navigated away and back.
 *
 * Cheap, unlike its server-side sibling. `GET /api/nodes/:id` is DB reads plus
 * an in-memory registry lookup for the live report; it never reaches the agent
 * and spawns nothing, where `GET /api/admin/server` runs `netstat` and the
 * service manager synchronously. That difference is why this one can poll
 * without a memo behind it.
 *
 * Every component on the node page reads this same key, so they share ONE
 * request, and TanStack's `refetchIntervalInBackground` defaults false — a
 * hidden tab is silent.
 */
export function useNode(id: string, enabled = true) {
  return useQuery({
    ...nodeDetailQuery(id),
    enabled: enabled && id.length > 0,
    refetchInterval: 5_000,
  });
}

/**
 * The node-detail read as query OPTIONS, so the imperative path shares the key
 * and the fetcher with {@link useNode} rather than restating them.
 *
 * It exists for one caller: the Nodes LIST row's maintenance action, which
 * needs `runningSubshells` — a detail-only, manager-only field the list
 * payload does not carry — to say in its confirmation how many subshells the
 * flip would stop. Fetching it at the moment it is asked for (through the
 * cache, so a page that already holds a fresh detail pays nothing) is the only
 * way that number can be true; a list that never had it could only guess.
 * @param id - The node to read
 */
export function nodeDetailQuery(id: string) {
  return {
    queryKey: [...NODE_QUERY_KEY, id],
    queryFn: () => apiFetch<NodeDetail>(`/api/nodes/${id}`),
    // Matched to the poll interval: above it, a remount would render a view
    // older than the cadence the page promises.
    staleTime: 5_000,
  };
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

/**
 * Starts or ends maintenance on one node (`PUT /api/nodes/:id/maintenance`).
 *
 * MANAGER-only server-side — the node's real owner, or an admin on the
 * control-plane host. An admin's instance-wide `edit` does NOT reach a foreign
 * agent node here, so the surfaces gate on `canManage` and the route is the
 * gate that matters.
 *
 * Turning it ON terminates every subshell on that machine, all owners'. That
 * is why the subshell list is invalidated beside the two node keys: the rows
 * this viewer can see went `terminated` the instant this answered, and unlike
 * the node queries nothing else on the page refetches them (the same
 * cross-domain reason `useRotateNodeKey` carries).
 *
 * The answer is the updated node view plus `stopped` and, when the node
 * refused a kill, `failed` — which a caller must SURFACE rather than discard
 * (`lib/node-maintenance.ts` holds the wording). A refused kill is not in
 * `stopped` precisely so nobody is told a pane is down and walks away from a
 * machine still running it, and typing this response as a plain view threw
 * that away at the last step.
 *
 * The detail cache is INVALIDATED rather than written through — the detail row
 * also carries `shares`, `runtime` and `runningSubshells`, and the last of
 * those is exactly the number this mutation just changed.
 */
export function useSetNodeMaintenance(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      apiFetch<MaintenanceResult>(`/api/nodes/${id}/maintenance`, {
        method: "PUT",
        body: JSON.stringify({ on }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
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

/**
 * Drive an enrolled node's service manager — start, stop, restart, install or
 * uninstall (spec 2026-09-12, node half).
 *
 * 409s carry the agent's own refusal: `NODE_OFFLINE`, `NODE_AGENT_TOO_OLD`,
 * `NODE_NOT_SUPERVISED`, `NODE_NO_SERVICE`, and `NODE_RESTART_KILLS_PANES`
 * (which `{ force: true }` overrides — only for the verbs that can close a
 * subshell; the server refuses it on the others). `local` is a 400: the
 * control plane manages itself through `/api/admin/server/*` instead.
 *
 * **`stop` and `uninstall` are owner-only, and one-way from here.** A command
 * reaches a node over the agent's own socket, so nothing in this app can start
 * an agent that is not running — say so before asking for either.
 */
export function useNodeService(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { verb: NodeServiceVerb; force?: boolean }) =>
      apiFetch<{ ok: true; detail?: string }>(`/api/nodes/${id}/service`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Every verb here changes the runtime report the card is drawn from —
    // whether a definition exists, whether it starts at login, the pid — and
    // this mutation used to write nothing back. The node detail query does NOT
    // poll, so "Install service" left the card showing "not installed" until
    // someone navigated away and back. `restart` is the one verb with its own
    // waiter (the agent's socket has to return first); the rest are answered
    // by the agent that is still connected, so a refetch now is correct.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
    },
  });
}

/**
 * The debug-logging switch for one node's agent.
 *
 * Writes the fresh flag straight into the node cache on success rather than
 * refetching: the answer IS the new state, and the node detail query does not
 * poll, so an invalidation would be a round trip for something already known.
 */
export function useSetNodeLogging(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (debug: boolean) =>
      apiFetch<{ debug: boolean }>(`/api/nodes/${id}/logging`, {
        method: "PUT",
        body: JSON.stringify({ debug }),
      }),
    onSuccess: ({ debug }) => {
      queryClient.setQueryData<NodeDetail>([...NODE_QUERY_KEY, id], (prev) =>
        prev?.runtime ? { ...prev, runtime: { ...prev.runtime, logging: { debug, source: "setting" } } } : prev,
      );
    },
  });
}

/**
 * Read a slice of a node's own agent log.
 *
 * A byte RANGE rather than a tail, because the view polls: it holds an offset
 * and asks for what arrived since. `truncated` means the file was replaced at
 * its cap and the held offset means nothing — start over from 0.
 */
export function useNodeLogSlice(id: string) {
  return useMutation({
    mutationFn: (args: { fromByte: number }) =>
      apiFetch<{ text: string; nextByte: number; size: number; truncated: boolean }>(
        `/api/nodes/${id}/logs?fromByte=${args.fromByte}`,
      ),
  });
}

/**
 * Repoint a node at another control plane — OWNER only.
 *
 * The address is validated server-side before the node is dialed, so an
 * unusable one is a 400 rather than a confusing 409 about a machine that is
 * merely offline. It takes effect on the agent's next restart, which this does
 * not perform.
 */
export function useSetNodeServerUrl(id: string) {
  return useMutation({
    mutationFn: (body: { serverUrl: string }) =>
      apiFetch<{ serverUrl: string; restartRequired: true }>(`/api/nodes/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  });
}
