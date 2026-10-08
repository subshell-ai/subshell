import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SshAliasesView,
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
 * refusal-shaped outcome answers 422 `{outcome}` and stores nothing; the
 * panel renders that, an `ApiError` with status 422.
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
