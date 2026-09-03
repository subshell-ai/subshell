import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { confirmDeleteSubshell, confirmTerminateSubshell } from "@/lib/subshell-confirmations";
import type { SubshellView } from "@/types/subshell";

/** Terminate / restart / delete for one subshell; the destructive ones ask. */
export interface SubshellMutations {
  /** Asks, then terminates the subshell's process */
  terminate: () => Promise<void>;
  /** Revives the subshell in place (same id): new process, conversation resumed where it can */
  restart: () => void;
  /** Asks, then deletes the subshell and its log */
  remove: () => Promise<void>;
  /** True while any of the three is in flight */
  busy: boolean;
  /** Flips pane-title auto-naming for the subshell (pin / unpin its name) */
  toggleTitleLock: () => Promise<void>;
  /** Flips the "notify when done" bell for the subshell */
  toggleNotify: () => Promise<void>;
  /** True while a restart is in flight */
  restarting: boolean;
  /** True while a delete is in flight */
  deleting: boolean;
}

/**
 * The single implementation of the subshell lifecycle actions, shared by
 * `SubshellActionsMenu` (cards, rows, the detail header) and the terminal's
 * exited-state panel. It owns the endpoints, the delete confirmation, and
 * the cache refresh; callers only decide what a delete *means* where they
 * are — leave the page, or stay put — through the callbacks. A restart is
 * in-place (same id): every surface just sees the refreshed row.
 * @param id - The subshell to act on
 * @param subshell - The loaded subshell, used for the delete prompt; actions
 *                  fired before it loads are ignored
 * @param onDeleted - Called once the subshell is gone
 */
export function useSubshellMutations(
  id: string,
  subshell: SubshellView | undefined,
  { onDeleted }: { onDeleted?: () => void } = {},
): SubshellMutations {
  const queryClient = useQueryClient();

  /** Refreshes the list feed and any open detail view. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SUBSHELL_QUERY_KEY });
  };

  const terminate = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/subshells/${id}/terminate`, { method: "POST" }),
    onSuccess: refresh,
  });
  const restart = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/subshells/${id}/restart`, { method: "POST" }),
    // Revival keeps the id: the refreshed queries ARE the whole sync story.
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/subshells/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      onDeleted?.();
    },
  });
  // No confirmation: pinning/unpinning is reversible and non-destructive.
  // Workspace pane titles show the subshell name, so those queries refresh
  // too (the sweep re-adopts the live title on the next pass).
  const toggleTitleLock = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/api/subshells/${id}/name`, {
        method: "PATCH",
        body: JSON.stringify({ autoTitle: subshell?.nameLocked === true }),
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
      apiFetch<{ ok: boolean }>(`/api/subshells/${id}/notify`, {
        method: "PATCH",
        body: JSON.stringify({ notify: subshell?.notify !== true }),
      }),
    onSuccess: refresh,
  });

  /** Runs the action without asking (failures land in the mutation state;
   *  the refreshed queries surface whatever actually happened). */
  function runNow(action: { mutate: () => void }): () => void {
    return () => {
      if (!subshell) return; // actions fired before load are ignored, as with asks
      action.mutate();
    };
  }

  async function askThen(ask: (name: string) => Promise<boolean>, action: { mutate: () => void }): Promise<void> {
    if (!subshell || !(await ask(subshell.name))) return;
    action.mutate();
  }

  // Terminate and delete are destructive and always ask. Restart does not:
  // it revives the same subshell and resumes the conversation — nothing is
  // lost by clicking it.
  return {
    terminate: () => askThen(confirmTerminateSubshell, terminate),
    restart: runNow(restart),
    remove: () => askThen(confirmDeleteSubshell, remove),
    toggleTitleLock: () => toggleTitleLock.mutateAsync().then(() => undefined),
    toggleNotify: () => toggleNotify.mutateAsync().then(() => undefined),
    busy: terminate.isPending || restart.isPending || remove.isPending,
    restarting: restart.isPending,
    deleting: remove.isPending,
  };
}
