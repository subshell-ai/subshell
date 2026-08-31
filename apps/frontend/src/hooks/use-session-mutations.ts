import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SESSION_QUERY_KEY, SESSIONS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { confirmDeleteSession, confirmTerminateSession } from "@/lib/session-confirmations";
import type { SessionView } from "@/types/session";

/** Terminate / restart / delete for one session; the destructive ones ask. */
export interface SessionMutations {
  /** Asks, then terminates the session's process */
  terminate: () => Promise<void>;
  /** Revives the session in place (same id): new process, conversation resumed where it can */
  restart: () => void;
  /** Asks, then deletes the session and its log */
  remove: () => Promise<void>;
  /** True while any of the three is in flight */
  busy: boolean;
  /** Flips pane-title auto-naming for the session (pin / unpin its name) */
  toggleTitleLock: () => Promise<void>;
  /** Flips the "notify when done" bell for the session */
  toggleNotify: () => Promise<void>;
  /** True while a restart is in flight */
  restarting: boolean;
  /** True while a delete is in flight */
  deleting: boolean;
}

/**
 * The single implementation of the session lifecycle actions, shared by
 * `SessionActionsMenu` (cards, rows, the detail header) and the terminal's
 * exited-state panel. It owns the endpoints, the delete confirmation, and
 * the cache refresh; callers only decide what a delete *means* where they
 * are — leave the page, or stay put — through the callbacks. A restart is
 * in-place (same id): every surface just sees the refreshed row.
 * @param id - The session to act on
 * @param session - The loaded session, used for the delete prompt; actions
 *                  fired before it loads are ignored
 * @param onDeleted - Called once the session is gone
 */
export function useSessionMutations(
  id: string,
  session: SessionView | undefined,
  { onDeleted }: { onDeleted?: () => void } = {},
): SessionMutations {
  const queryClient = useQueryClient();

  /** Refreshes the list feed and any open detail view. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };

  const terminate = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/sessions/${id}/terminate`, { method: "POST" }),
    onSuccess: refresh,
  });
  const restart = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/sessions/${id}/restart`, { method: "POST" }),
    // Revival keeps the id: the refreshed queries ARE the whole sync story.
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      onDeleted?.();
    },
  });
  // No confirmation: pinning/unpinning is reversible and non-destructive.
  // Workspace pane titles show the session name, so those queries refresh
  // too (the sweep re-adopts the live title on the next pass).
  const toggleTitleLock = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/api/sessions/${id}/name`, {
        method: "PATCH",
        body: JSON.stringify({ autoTitle: session?.nameLocked === true }),
      }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
  });

  // No confirmation and no workspace refresh: the bell changes no
  // pane-visible field — only the list/detail queries need to re-read it.
  const toggleNotify = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/api/sessions/${id}/notify`, {
        method: "PATCH",
        body: JSON.stringify({ notify: session?.notify !== true }),
      }),
    onSuccess: refresh,
  });

  /** Runs the action without asking (failures land in the mutation state;
   *  the refreshed queries surface whatever actually happened). */
  function runNow(action: { mutate: () => void }): () => void {
    return () => {
      if (!session) return; // actions fired before load are ignored, as with asks
      action.mutate();
    };
  }

  async function askThen(ask: (name: string) => Promise<boolean>, action: { mutate: () => void }): Promise<void> {
    if (!session || !(await ask(session.name))) return;
    action.mutate();
  }

  // Terminate and delete are destructive and always ask. Restart does not:
  // it revives the same session and resumes the conversation — nothing is
  // lost by clicking it.
  return {
    terminate: () => askThen(confirmTerminateSession, terminate),
    restart: runNow(restart),
    remove: () => askThen(confirmDeleteSession, remove),
    toggleTitleLock: () => toggleTitleLock.mutateAsync().then(() => undefined),
    toggleNotify: () => toggleNotify.mutateAsync().then(() => undefined),
    busy: terminate.isPending || restart.isPending || remove.isPending,
    restarting: restart.isPending,
    deleting: remove.isPending,
  };
}
