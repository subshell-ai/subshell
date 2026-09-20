import { apiFetch } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isSubshellDead, isSubshellExited } from "@/components/subshell-terminal";
import { useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { SUBSHELL_QUERY_KEY } from "@/lib/query-keys";
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
  const _queryClient = useQueryClient();
  // The root feed's delivery state decides whether this page still owns the
  // list's refresh (see the effect below). Pre-auth or on a bare route the
  // provider answers `false` — the conservative side, which just means the
  // poll behaves exactly as it did before.
  const { connected: feedConnected } = useLiveSubshellsFeed();

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

  // NO POLL. The live socket pushes every change to this row (spec
  // 2026-09-19): the reconcile sweep, a terminate, a restart and a rename all
  // publish, and the feed writes them into `SUBSHELLS_QUERY_KEY`. The 5 s
  // interval that used to live here invalidated BOTH this row and the whole
  // list, and the list rebuild captured every running pane's screen — the
  // single most expensive thing a quiet subshell page did.
  return { subshell, isLoading, isError, isNotFound, exited, dead };
}
