import { useQuery } from "@tanstack/react-query";
import { polledInterval } from "@/hooks/polled-interval";
import { SUMMARY_KEY } from "@/hooks/query-keys";
import { useForeground } from "@/hooks/use-foreground";
import { useSessions } from "@/hooks/use-sessions";
import { waitingCount } from "@/lib/session-order";
import { useMote } from "@/providers/subshell-provider";

/**
 * Badge number (spec §Screens): the summary endpoint when the instance has
 * it, else derived from the same polled list — never a second network loop.
 * The summary refetch follows the LIST's policy (same interval inputs), so
 * the badge is as live as the list — a persistently-mounted consumer never
 * remounts, and RN's focus manager fires no `visibilitychange` (a one-shot
 * `staleTime` would freeze the number for the whole foreground session;
 * review found exactly that, 2026-08-31).
 */
export function useWaitingState(): { waiting: number; loading: boolean } {
  const { client } = useMote();
  const sessions = useSessions();
  const foreground = useForeground();
  const summary = useQuery({
    enabled: Boolean(client),
    queryKey: SUMMARY_KEY,
    queryFn: () => client?.summary(),
    staleTime: 2000,
    retry: false, // 404 on older instances is the fallback signal, not an error to fight
    refetchInterval: () => polledInterval(foreground, () => sessions.data),
    refetchIntervalInBackground: false,
  });
  // "loading" = signed in and NEITHER source has settled its first attempt;
  // consumers that must not act on a not-yet-known count (the icon badge)
  // gate on this instead of reading 0 out of the empty-array fallback
  // (review, Important #1: cold start would flash the badge to 0).
  const loading = Boolean(client) && sessions.isPending && summary.isPending;
  return { waiting: summary.data?.waiting ?? waitingCount(sessions.data ?? []), loading };
}

export function useWaitingCount(): number {
  return useWaitingState().waiting;
}
