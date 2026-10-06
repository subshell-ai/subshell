import { ApiError } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import {
  type SshRuntimeDiscoveryView,
  type SshRuntimeHarnessesView,
  type SshRuntimeListDirsResult,
  type SshRuntimePaneIdentity,
  type SshRuntimeResolveView,
  type SshRuntimeSessionView,
  sshRuntimeFetch,
} from "@/lib/ssh-runtime";

/**
 * The personal Connect-over-SSH surface (design 2026-10-05 §1/§7): the
 * caller's own sessions, the wizard's pre-session reads (discovery, resolve),
 * and the session verbs. Every endpoint is cookie-scoped server-side, and the
 * server has already filtered to the caller's own rows and own nodes - these
 * hooks mirror the contract, they do not re-derive it.
 *
 * `list-dirs` is a mutation, not a query: each browse click asks for the path
 * named in the body, and the answer is a moment's listing on a live session,
 * not a cacheable resource.
 */

export const SSH_SESSIONS_QUERY_KEY = ["ssh-runtime-sessions"] as const;

/** The discovery read's key, per node. */
export const SSH_DISCOVERY_QUERY_KEY = (nodeId: string) => ["ssh-runtime-discovery", nodeId] as const;

/**
 * The pane identity read's key prefix; one pane's row is
 * `[...SSH_PANE_IDENTITY_QUERY_KEY, subshellId]`. The prefix alone is what a
 * session close invalidates: every launched pane's identity line changes
 * meaning the moment its session closes, and the pane ids are not known here.
 */
export const SSH_PANE_IDENTITY_QUERY_KEY = ["ssh-runtime-pane-identity"] as const;

/** The caller's sessions, newest first. */
export function useSshSessions() {
  return useQuery({
    queryKey: SSH_SESSIONS_QUERY_KEY,
    queryFn: () => sshRuntimeFetch<{ sessions: SshRuntimeSessionView[] }>("/api/ssh-runtime/sessions"),
  });
}

/** Alias names on one node (enabled only while the wizard has chosen a machine). */
export function useSshDiscovery(nodeId: string | null, enabled = true) {
  return useQuery({
    queryKey: SSH_DISCOVERY_QUERY_KEY(nodeId ?? ""),
    queryFn: () =>
      sshRuntimeFetch<SshRuntimeDiscoveryView>(`/api/ssh-runtime/discovery?nodeId=${encodeURIComponent(nodeId ?? "")}`),
    enabled: enabled && nodeId !== null && nodeId !== "",
    staleTime: 30_000,
    retry: false,
  });
}

/** One alias on one node, resolved into the concrete destination the open will carry. */
export function useSshResolve() {
  return useMutation({
    mutationFn: (body: { nodeId: string; alias: string }) =>
      sshRuntimeFetch<SshRuntimeResolveView>("/api/ssh-runtime/resolve", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

/** Open a session through a node the caller owns; invalidates the history list. */
export function useSshOpen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      connectingNodeId: string;
      target: { alias: string; host: string; port: number; user: string | null; identityFile: string | null };
    }) =>
      sshRuntimeFetch<SshRuntimeSessionView>("/api/ssh-runtime/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SSH_SESSIONS_QUERY_KEY });
    },
  });
}

/** Close a session (the runtime exits; destination panes keep running - the server says so). */
export function useSshClose() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      sshRuntimeFetch<{ ok: true }>(`/api/ssh-runtime/sessions/${id}/close`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SSH_SESSIONS_QUERY_KEY });
      // The client now KNOWS this session is closed: every pane identity read
      // must re-ask, or a still-mounted pane page keeps saying "connected"
      // for a staleTime nobody can wait out from here.
      void queryClient.invalidateQueries({ queryKey: SSH_PANE_IDENTITY_QUERY_KEY });
    },
  });
}

/** One directory listing on a live session (the remote folder picker's read). */
export function useSshListDirs() {
  return useMutation({
    mutationFn: (body: { sessionId: string; path: string }) =>
      sshRuntimeFetch<SshRuntimeListDirsResult>(`/api/ssh-runtime/sessions/${body.sessionId}/list-dirs`, {
        method: "POST",
        body: JSON.stringify({ path: body.path }),
      }),
  });
}

/** Launch the terminal pane; the rail's subshell list must learn the new row. */
export function useSshLaunchTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { sessionId: string; cwd: string; cols?: number; rows?: number }) =>
      sshRuntimeFetch<{ subshellId: string }>(`/api/ssh-runtime/sessions/${body.sessionId}/launch-terminal`, {
        method: "POST",
        body: JSON.stringify({
          cwd: body.cwd,
          ...(body.cols !== undefined ? { cols: body.cols } : {}),
          ...(body.rows !== undefined ? { rows: body.rows } : {}),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SSH_SESSIONS_QUERY_KEY });
    },
  });
}

/** The harnesses mirror's key, per session. */
export const SSH_HARNESS_QUERY_KEY = (sessionId: string) => ["ssh-runtime-harnesses", sessionId] as const;

/**
 * The cached harness mirror for one session (a pure row read: works offline,
 * never a round trip - the detect mutation below is what asks the machine).
 */
export function useSshSessionHarnesses(sessionId: string | null) {
  return useQuery({
    queryKey: SSH_HARNESS_QUERY_KEY(sessionId ?? ""),
    queryFn: () => sshRuntimeFetch<SshRuntimeHarnessesView>(`/api/ssh-runtime/sessions/${sessionId}/harnesses`),
    enabled: sessionId !== null && sessionId !== "",
    retry: false,
  });
}

/** Ask the destination what is installed NOW; the answer lands in the cached query. */
export function useSshDetectHarnesses(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (harnessIds?: string[]) =>
      sshRuntimeFetch<SshRuntimeHarnessesView>(`/api/ssh-runtime/sessions/${sessionId}/harnesses/detect`, {
        method: "POST",
        body: JSON.stringify(harnessIds ? { harnessIds } : {}),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData(SSH_HARNESS_QUERY_KEY(sessionId), view);
    },
  });
}

/** Launch a harness (optionally a preset) on a live session; the rail's list learns the new row. */
export function useSshLaunchHarness() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { sessionId: string; harnessId: string; presetId?: string | null; cwd: string }) =>
      sshRuntimeFetch<{ subshellId: string }>(`/api/ssh-runtime/sessions/${body.sessionId}/launch-harness`, {
        method: "POST",
        body: JSON.stringify({
          harnessId: body.harnessId,
          ...(body.presetId !== undefined && body.presetId !== null ? { presetId: body.presetId } : {}),
          cwd: body.cwd,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SSH_SESSIONS_QUERY_KEY });
    },
  });
}

/**
 * The pane page's trusted identity read. A 404 is the ORDINARY answer for a
 * non-SSH pane (the route refuses foreign and unknown alike), so it resolves
 * to null instead of an error - the line renders on SSH panes and nowhere
 * else, and no pane page ever shows a fetch failure for being a normal pane.
 */
export function useSshPaneIdentity(subshellId: string) {
  return useQuery<SshRuntimePaneIdentity | null>({
    queryKey: [...SSH_PANE_IDENTITY_QUERY_KEY, subshellId],
    queryFn: async () => {
      try {
        return await sshRuntimeFetch<SshRuntimePaneIdentity>(
          `/api/ssh-runtime/sessions/by-pane/${encodeURIComponent(subshellId)}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}
