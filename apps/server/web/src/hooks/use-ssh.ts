import { apiFetch, apiPost, NODE_QUERY_KEY, NODES_QUERY_KEY } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SshAgentIdentity,
  SshAliasesView,
  SshHostPin,
  SshLaunchRequest,
  SshLaunchResponse,
  SshSavedHost,
  SshSavedHostsView,
  SshSaveHostRequest,
} from "@/lib/ssh";

/**
 * The SSH launcher's data (spec 2026-10-07 §7), following `use-prompts.ts`:
 * one key per list, one URL per key, mutations invalidate rather than patch.
 *
 * The saved-hosts view carries the ledger AND the default-machine preference,
 * so every mutation that can move either one invalidates `["ssh-saved-hosts"]`
 * and nothing else: a launch touched the recency row server-side, a save or
 * delete moves the ledger, the preference PATCH moves `defaultNodeId`. The
 * aliases are the MACHINE's config, which none of these acts edits, so no
 * mutation invalidates them — the machine disclosure refetches them only when
 * the chosen machine changes.
 */

export const SSH_SAVED_HOSTS_QUERY_KEY = ["ssh-saved-hosts"] as const;
export const sshAliasesQueryKey = (nodeId: string) => ["ssh-aliases", nodeId] as const;

/** The owner's saved + recent destinations and their default connecting machine. */
export function useSshSavedHosts() {
  return useQuery({
    queryKey: SSH_SAVED_HOSTS_QUERY_KEY,
    queryFn: () => apiFetch<SshSavedHostsView>("/api/ssh/saved-hosts"),
  });
}

/**
 * The machine's alias names for the destination picker. `enabled` gates on
 * the caller actually having chosen a machine: an unresolved picker asks
 * nothing, so a half-open panel never pings a node with `node=` empty.
 */
export function useSshAliases(nodeId: string | null) {
  return useQuery({
    queryKey: sshAliasesQueryKey(nodeId ?? ""),
    queryFn: () => apiFetch<SshAliasesView>(`/api/ssh/aliases?node=${encodeURIComponent(nodeId ?? "")}`),
    enabled: nodeId !== null,
  });
}

/** Invalidate the ledger after an act that moved it (the one rule the mutations share). */
function useInvalidateSavedHosts(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SSH_SAVED_HOSTS_QUERY_KEY });
}

/**
 * `PUT /api/ssh/saved-hosts` — resolves the destination first, so a
 * refusal-shaped outcome answers 422 `{outcome}` (an `ApiError` with status
 * 422) and stores nothing. Both callers treat it best-effort: the connect
 * panel's Remember act and the Recent-star act do not render that refusal,
 * because a row already exists from the launch's server-side recency touch,
 * so a failed save costs only the `savedAt` pin, never the destination.
 */
export function useSaveSshHost() {
  const invalidate = useInvalidateSavedHosts();
  return useMutation({
    mutationFn: (draft: SshSaveHostRequest) =>
      apiFetch<SshSavedHost>("/api/ssh/saved-hosts", { method: "PUT", body: JSON.stringify(draft) }),
    onSuccess: () => void invalidate(),
  });
}

/** `DELETE /api/ssh/saved-hosts/:id` — 204 no body; a foreign row is the same 404 as an absent one. */
export function useDeleteSshHost() {
  const invalidate = useInvalidateSavedHosts();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/ssh/saved-hosts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });
}

/**
 * `PATCH /api/ssh/preferences` — sets (or clears, with null) the default
 * connecting machine. The answer echoes the stored id; the cache still
 * refetches, because the SAME view carries the ledger and a stale preference
 * there is the picker defaulting to the wrong machine.
 */
export function useSetDefaultNode() {
  const invalidate = useInvalidateSavedHosts();
  return useMutation({
    mutationFn: (defaultNodeId: string | null) =>
      apiFetch<{ defaultNodeId: string | null }>("/api/ssh/preferences", {
        method: "PATCH",
        body: JSON.stringify({ defaultNodeId }),
      }),
    onSuccess: () => void invalidate(),
  });
}

/**
 * `POST /api/ssh/launch` `{node, destination, name?}` — one POST, one pane.
 * Success invalidates the ledger only: the launch touched (or created) the
 * destination's recency row server-side, while the machine's aliases are
 * untouched by the act.
 */
export function useLaunchSsh() {
  const invalidate = useInvalidateSavedHosts();
  return useMutation({
    mutationFn: (draft: SshLaunchRequest) => apiPost<SshLaunchResponse>("/api/ssh/launch", draft),
    onSuccess: () => void invalidate(),
  });
}

/* ------------------------------------------------------------------ */
/* live key identities and destination host-key pins          */
/* (spec 2026-10-08 §6, §8-§9; the operator screens of Task 15)         */
/* ------------------------------------------------------------------ */

export const SSH_HOST_PINS_QUERY_KEY = ["ssh-host-pins"] as const;
export const sshNodeRosterQueryKey = (nodeId: string) => ["ssh-node-roster", nodeId] as const;

export function useSshNodeRoster(nodeId: string | null, enabled = true) {
  return useQuery({
    queryKey: sshNodeRosterQueryKey(nodeId ?? ""),
    queryFn: () =>
      apiFetch<{ identities: SshAgentIdentity[] }>(`/api/ssh/identities?node=${encodeURIComponent(nodeId ?? "")}`),
    enabled: enabled && nodeId !== null && nodeId !== "",
  });
}

export function useSshHostPins() {
  return useQuery({
    queryKey: SSH_HOST_PINS_QUERY_KEY,
    queryFn: () => apiFetch<{ pins: SshHostPin[] }>("/api/ssh/host-pins"),
  });
}

/** The explicit-pin body (spec §9's "or an explicit pin" door): canonical destination + one known_hosts line. */
export interface SshHostPinDraft {
  /** Canonical resolved destination `user@host:port` (the spelling the launch keys the pin by) */
  destination: string;
  /** The pinned entry in OpenSSH known_hosts form */
  hostKey: string;
}

/**
 * `POST /api/ssh/host-pins` - supplies an explicit pin for a destination the
 * key home has not connected to yet. A destination already pinned to a
 * DIFFERENT key is the named hard block (409, nothing written): delete the
 * pin first, that is the whole recovery flow.
 */
export function useCreateSshHostPin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: SshHostPinDraft) => apiPost<{ pin: SshHostPin }>("/api/ssh/host-pins", draft),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SSH_HOST_PINS_QUERY_KEY }),
  });
}

/**
 * `DELETE /api/ssh/host-pins/:destination` - the TOFU recovery's first half;
 * the next capture at a fresh key re-decides trust. The destination is the
 * key, so it rides the path encoded.
 */
export function useDeleteSshHostPin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (destination: string) =>
      apiFetch<{ deleted: boolean }>(`/api/ssh/host-pins/${encodeURIComponent(destination)}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SSH_HOST_PINS_QUERY_KEY }),
  });
}

/**
 * `POST /api/nodes/:id/machine-pins/:peerNodeId/repair` - the §4.5 machine
 * trust re-pair (spec 2026-10-08 §4.5, Task 17): the OWNER of one machine
 * replaces ONE peer's stored pin with that peer's current registered public
 * pair, which the plane re-delivers over the machine's live link. The route
 * answers 409 while the machine is offline and 502 when the machine itself
 * refuses; on success the act has already landed in the machine's store, so
 * the invalidation only re-reads what the node's next report mirrors.
 * Both ids ride the path encoded; there is no body to lie with.
 */
export function useRepairSshMachinePin(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (peerNodeId: string) =>
      apiFetch<{ repaired: boolean }>(
        `/api/nodes/${encodeURIComponent(nodeId)}/machine-pins/${encodeURIComponent(peerNodeId)}/repair`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, nodeId] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
    },
  });
}

export function useSshReadiness() {
  return useQuery({
    queryKey: ["ssh-readiness"],
    queryFn: () => apiFetch<{ machines: import("@/lib/ssh").SshMachineReadiness[] }>("/api/ssh/readiness"),
    refetchInterval: 5000,
  });
}

/** An explicit SSH configuration act; readiness must be re-read before claiming readiness. */
export function useEnableSsh() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/nodes/${encodeURIComponent(id)}/ssh-enabled`, {
        method: "PUT",
        body: JSON.stringify({ on: true }),
      }),
    onSuccess: async (_data, id) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["ssh-readiness"] }),
        client.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] }),
        client.invalidateQueries({ queryKey: NODES_QUERY_KEY }),
      ]);
    },
  });
}
