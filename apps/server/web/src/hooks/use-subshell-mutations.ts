import { apiFetch } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { confirmCloseSubshell } from "@/lib/subshell-confirmations";
import type { SubshellView } from "@/types/subshell";

/** Restart / close for one subshell; the destructive one asks. */
export interface SubshellMutations {
  /** Revives the subshell in place (same id): new process, conversation resumed where it can */
  restart: () => void;
  /** Asks, then closes the subshell (terminates it and deletes its row + log) */
  remove: () => Promise<void>;
  /** True while any of the two is in flight */
  busy: boolean;
  /** Flips the "notify when done" bell for the subshell */
  toggleNotify: () => Promise<void>;
  /** True while a restart is in flight */
  restarting: boolean;
  /** True while a close is in flight */
  deleting: boolean;
}

/**
 * The single implementation of the subshell lifecycle actions, shared by
 * `SubshellActionsMenu` (cards, rows, the detail header) and the terminal's
 * exited-state panel. It owns the endpoints, the close confirmation, and the
 * cache refresh; callers only decide what a close *means* where they are —
 * leave the page, or stay put — through the callbacks. A restart is
 * in-place (same id): every surface just sees the refreshed row.
 *
 * Terminate is deliberately absent from the human UI (spec 2026-09-03):
 * Close subsumes it (the DELETE terminates a running process first), and
 * the endpoint remains for the agents' MCP tool. Renaming is likewise the
 * ONLY title-pin gesture — no separate lock mutation.
 * @param id - The subshell to act on
 * @param subshell - The loaded subshell, used for the close prompt; actions
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

  /** Also re-reads every open workspace's detail: a pane row COPIES this
   * subshell's name/status/alive (exactly what `SubshellPane` renders and
   * what the dock's vanish-the-panel reconcile effect counts on), and
   * workspace detail has NO poll of its own — an act done from outside the
   * dock that skips this leaves the tile standing forever (operator bug
   * 2026-09-27: a sidebar Close never closed the workspace tab). The rename
   * dialog has invalidated `WORKSPACE_QUERY_KEY` for the same reason
   * all along; this is the same fact for status and existence. */
  const refreshWithPanes = () => {
    refresh();
    void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
  };

  const restart = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/subshells/${id}/restart`, { method: "POST" }),
    // Revival keeps the id; the refreshed queries ARE the whole sync story —
    // pane rows included, since they copied the running/alive the flip moved.
    onSuccess: refreshWithPanes,
  });
  const remove = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/subshells/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      // The pane CASCADE goes through the workspace read too: closing from
      // anywhere must close the dock tab, not just the card.
      refreshWithPanes();
      onDeleted?.();
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

  // Closing is destructive and always asks. Restart does not: it revives the
  // same subshell and resumes the conversation — nothing is lost by clicking
  // it.
  return {
    restart: runNow(restart),
    remove: () => askThen(confirmCloseSubshell, remove),
    toggleNotify: () => toggleNotify.mutateAsync().then(() => undefined),
    busy: restart.isPending || remove.isPending,
    restarting: restart.isPending,
    deleting: remove.isPending,
  };
}
