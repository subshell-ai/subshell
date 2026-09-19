import type { NodeServiceVerb } from "@internal/subshell-protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY } from "../lib/query-keys";
import type { MaintenanceResult, NodeDetail } from "../types/node";

/**
 * The per-node reads and writes the node-admin cards share (spec 2026-08-31 §9,
 * spec 2026-09-12 node half). Split from the SPA's `use-nodes.ts` with the
 * cards: these speak a contract that TWO backends honour — the control plane's
 * `/api/nodes/:id/*` and the node's own loopback mirror of it — while the
 * plane-only half (the list, shares, setup keys, rename, rotate) stays there.
 *
 * Two behaviours deliberately do NOT live here, because they are facts about
 * the plane rather than about a node:
 *
 * - The subshell-list invalidation a maintenance flip needs. The card takes an
 *   `onMaintenanceChanged` callback for it; the node's local dashboard has no
 *   subshell query to invalidate, so it passes nothing.
 * - The folder-picker invalidations an allowed-dirs save needs (`explore`,
 *   `recent-paths`) — same reason, same callback shape (`onDirsSaved`).
 */

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
 * an in-memory registry lookup for the live report; it never reaches the node
 * and spawns nothing, where `GET /api/admin/server` runs `netstat` and the
 * service manager synchronously. That difference is why this one can poll
 * without a memo behind it. (On the node's own dashboard the read is even
 * cheaper — it is this process answering about itself — and the poll still
 * earns its keep: `service start` after a stop lands the fresh view without a
 * reload.)
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
 * Starts or ends maintenance on one node (`PUT /api/nodes/:id/maintenance`).
 *
 * MANAGER-only server-side — the node's real owner, or an admin on the
 * control-plane host. An admin's instance-wide `edit` does NOT reach a foreign
 * agent node here, so the surfaces gate on `canManage` and the route is the
 * gate that matters.
 *
 * Turning it ON terminates every subshell on that machine, all owners'. The
 * CALLER reports that fallout through `onMaintenanceChanged` — on the plane
 * that is invalidating the subshell list (the rows this viewer can see went
 * `terminated` the instant this answered; the same cross-domain reason
 * `useRotateNodeKey` carries); on the node's own dashboard there is no
 * subshell query to invalidate and the callback is simply absent.
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
    },
  });
}

/**
 * Replaces a node's directory allowlist — the complete set, never a delta.
 *
 * OWNER-only server-side (`canManage`); the card hides the controls for
 * everyone else, but the server is the gate. An empty array CLEARS the rules
 * and returns the node to unrestricted.
 *
 * Not used at all by the node's own dashboard: the plane holds its own copy
 * of this list, enforces it at launch, and re-pushes on every `ready`, so the
 * local Settings page shows the file read-only and points at the Nodes UI.
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
    },
  });
}

/**
 * Drive a node's service manager — start, stop, restart, install or
 * uninstall (spec 2026-09-12, node half).
 *
 * 409s carry the node's own refusal: `NODE_OFFLINE`, `NODE_AGENT_TOO_OLD`,
 * `NODE_NOT_SUPERVISED`, `NODE_NO_SERVICE`, and `NODE_RESTART_KILLS_PANES`
 * (which `{ force: true }` overrides — only for the verbs that can close a
 * subshell; the server refuses it on the others). `local` is a 400: the
 * control plane manages itself through `/api/admin/server/*` instead.
 *
 * **`stop` and `uninstall` are one-way from a remote page.** A command reaches
 * a node over the node's own socket, so nothing in the plane's SPA can start
 * a node that is not running — say so before asking for either. On the node's
 * own dashboard the same is true of the page itself: the dashboard is served
 * by the daemon it would stop.
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
    // waiter (the node's socket has to return first); the rest are answered
    // by the node that is still connected, so a refetch now is correct.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
    },
  });
}

/**
 * The debug-logging switch for one node.
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
 * Read a slice of a node's own log.
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
 * Repoint a node at another control plane (`PATCH /api/nodes/:id/config`).
 *
 * On the plane this is OWNER-only: the node dials whatever address is named,
 * carrying the key this plane holds. On the node's own dashboard it is the
 * same act the CLI's `configure` performs — the machine's own file, its own
 * credential — and the response has the same shape either way. It takes
 * effect on the node's next restart, which this does not perform.
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
