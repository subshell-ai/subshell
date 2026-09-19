import { apiFetch } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isSubshellDead, isSubshellExited } from "@/components/subshell-terminal";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { isNotFoundSubshellError } from "@/lib/subshell-not-found";
import type { SubshellView } from "@/types/subshell";

/** Everything the subshell page reads about the subshell it is showing. */
export interface SubshellData {
  /** The subshell being viewed (undefined while it loads, or if it is gone) */
  subshell: SubshellView | undefined;
  /** True while the first fetch has not settled — the page defers mounting the
   * terminal until this clears, so a visit is ONE attach/replay, not two */
  isLoading: boolean;
  /** True when the record could not be fetched at all (gone/unknown id) */
  isError: boolean;
  /** True when the record's fetch was answered 404: gone or never shared —
   * it will never arrive, so the page shows the not-found card instead of
   * mounting a terminal whose attach is doomed (spec 2026-09-03 §3). */
  isNotFound: boolean;
  /** True when the harness process has died while the record still says running */
  exited: boolean;
  /** True for either dead-but-kept shape: crashed-while-managed or terminated */
  dead: boolean;
}

/**
 * Loads one subshell, keeping it fresh while it can still change.
 * @param id - The subshell being viewed
 * @returns The subshell and the derived exited/dead flags
 */
export function useSubshellData(id: string): SubshellData {
  const queryClient = useQueryClient();

  const {
    data: subshell,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: [...SUBSHELL_QUERY_KEY, id],
    queryFn: () => apiFetch<SubshellView>(`/api/subshells/${id}`),
  });

  const isNotFound = isNotFoundSubshellError(error);
  const exited = isSubshellExited(subshell);
  const dead = isSubshellDead(subshell);

  // ALIVE & TERMINATED subshells: poll every few seconds so the exited state /
  // restart-pending indicator catch a process death without waiting for the
  // next SSE heartbeat (the WS can also appear connected, so it cannot be
  // relied on here). The list invalidation keeps the sidebar's recent-subshells
  // sub-list honest. Exited or terminated subshells no longer change; their
  // data is read from the single fetch above.
  useEffect(() => {
    if (dead) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: [...SUBSHELL_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
    }, 5000);
    return () => clearInterval(timer);
  }, [dead, id, queryClient]);

  return { subshell, isLoading, isError, isNotFound, exited, dead };
}
