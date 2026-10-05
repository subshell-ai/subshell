import { apiFetch, apiPost } from "@internal/node-admin";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SshActorSide,
  SshConnectionListView,
  SshControlView,
  SshDiscoveryView,
  SshGrantListView,
  SshResolveView,
  SshTerminalView,
  SshTestConnectionView,
} from "@/lib/ssh";

/**
 * The SSH settings data layer: every `/api/ssh` read and act the SSH
 * connections page and the managed-terminal chrome perform, over the cookie
 * session `apiFetch` already carries. The routes are human-cookie only for
 * writes (spec §2: "Human configuration, discovery, grants, and control
 * changes require a cookie session"), so there is nothing here a machine
 * token could call, and the hooks never pass a credential of their own.
 *
 * Mutations invalidate rather than patch, the house rule; the ONE exception
 * is `ssh-control`, whose answer is written straight into this tab's facts
 * store by the caller: the generation is the server's raised counter and no
 * refetch re-reads it (there is no per-pane SSH GET yet, the task-F report
 * names the gap).
 */

/** The caller's connections (`GET /api/ssh/connections`). */
export const SSH_CONNECTIONS_QUERY_KEY = ["ssh-connections"] as const;

/** Prefix of one connection's grant rows: `[...SSH_GRANTS_QUERY_KEY, connectionId]`. */
export const SSH_GRANTS_QUERY_KEY = ["ssh-grants"] as const;

/** Prefix of one node's alias discovery: `[...SSH_DISCOVERY_QUERY_KEY, nodeId]`. */
export const SSH_DISCOVERY_QUERY_KEY = ["ssh-discovery"] as const;

export function useSshConnections() {
  return useQuery({
    queryKey: SSH_CONNECTIONS_QUERY_KEY,
    queryFn: () => apiFetch<SshConnectionListView>("/api/ssh/connections"),
  });
}

/**
 * Alias NAMES on the selected connecting node (`GET /api/ssh/discovery`).
 * `enabled: false` while no node is picked so the page mount fetches nothing;
 * the key carries the node so a re-pick re-reads rather than reusing an
 * answer that came from a different machine's `~/.ssh/config`.
 */
export function useSshDiscovery(nodeId: string | null) {
  return useQuery({
    queryKey: [...SSH_DISCOVERY_QUERY_KEY, nodeId],
    queryFn: () => apiFetch<SshDiscoveryView>(`/api/ssh/discovery?nodeId=${encodeURIComponent(nodeId ?? "")}`),
    enabled: nodeId !== null && nodeId !== "",
  });
}

/**
 * `POST /api/ssh/connections/resolve`: the human review step. The answer is
 * either the approved snapshot or a NAMED refusal (a 200, per the frozen
 * grammar) - the caller renders the refusal's code sentence and blocks Save;
 * a rejected resolve is data, not a failed request.
 */
export function useResolveSshConnection() {
  return useMutation({
    mutationFn: ({ nodeId, alias }: { nodeId: string; alias: string }) =>
      apiPost<SshResolveView>("/api/ssh/connections/resolve", { nodeId, alias }),
  });
}

/** `POST /api/ssh/connections/test`: the node's FIXED benign probe against a snapshot. */
export function useTestSshConnection() {
  return useMutation({
    mutationFn: ({ nodeId, snapshot }: { nodeId: string; snapshot: SshConnectionSnapshotWire }) =>
      apiPost<SshTestConnectionView>("/api/ssh/connections/test", { nodeId, snapshot }),
  });
}

/** Saving a resolved snapshot as a connection. */
export function useCreateSshConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      nodeId: string;
      displayName: string;
      snapshot: SshConnectionSnapshotWire;
      remoteDir?: string | null;
    }) => apiPost("/api/ssh/connections", body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SSH_CONNECTIONS_QUERY_KEY }),
  });
}

/**
 * `PATCH /api/ssh/connections/:id`. A body carrying `snapshot` creates a NEW
 * revision and invalidates every grant (spec §2) - the dialog says so before
 * it sends one.
 */
export function useUpdateSshConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { displayName?: string; remoteDir?: string | null; snapshot?: SshConnectionSnapshotWire };
    }) => apiFetch(`/api/ssh/connections/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SSH_CONNECTIONS_QUERY_KEY }),
  });
}

/** Delete, refused server-side while work is active; the refusal rides back as an `ApiError`. */
export function useDeleteSshConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/ssh/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SSH_CONNECTIONS_QUERY_KEY }),
  });
}

/** One connection's grant rows, active and revoked history. `enabled` gates the fetch behind the open dialog. */
export function useSshGrants(connectionId: string | null) {
  return useQuery({
    queryKey: [...SSH_GRANTS_QUERY_KEY, connectionId],
    queryFn: () => apiFetch<SshGrantListView>(`/api/ssh/connections/${connectionId}/grants`),
    enabled: connectionId !== null,
  });
}

/** Grant the connection's CURRENT revision to one running pane (the pane's live key identity is resolved server-side). */
export function useGrantSshConnection(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subshellId: string) => apiPost(`/api/ssh/connections/${connectionId}/grants`, { subshellId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...SSH_GRANTS_QUERY_KEY, connectionId] });
    },
  });
}

/** Revoke a pane's live grant: history stays, new dispatch stops, queued input is fenced node-side. */
export function useRevokeSshConnection(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subshellId: string) =>
      apiFetch(`/api/ssh/connections/${connectionId}/grants/${encodeURIComponent(subshellId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...SSH_GRANTS_QUERY_KEY, connectionId] });
    },
  });
}

/** `POST /api/ssh/terminals`: open a managed SSH terminal pane; the answer carries the pane's control facts. */
export function useOpenSshTerminal() {
  return useMutation({
    mutationFn: ({ connectionId }: { connectionId: string }) =>
      apiPost<SshTerminalView>("/api/ssh/terminals", { connectionId }),
  });
}

/**
 * `POST /api/subshells/:id/ssh-control`: the human takeover/return act.
 * Humans may move the pane to either side; the server raises the generation
 * and fences stale input, and the caller records the new state into this
 * tab's facts store.
 */
export function useSetSshPaneControl(subshellId: string) {
  return useMutation({
    mutationFn: (mode: SshActorSide) =>
      apiPost<SshControlView>(`/api/subshells/${encodeURIComponent(subshellId)}/ssh-control`, { mode }),
  });
}
