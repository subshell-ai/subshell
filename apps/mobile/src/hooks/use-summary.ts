import { useQuery } from "@tanstack/react-query";
import { useForeground } from "@/hooks/use-foreground";
import { useSessions } from "@/hooks/use-sessions";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import { waitingCount } from "@/lib/session-order";
import { useMote } from "@/providers/mote-provider";

/**
 * Badge number (spec §Screens): the summary endpoint when the instance has
 * it, else derived from the same polled list — never a second network loop.
 * The summary refetch follows the LIST's policy (same interval inputs), so
 * the badge is as live as the list — a persistently-mounted consumer never
 * remounts, and RN's focus manager fires no `visibilitychange` (a one-shot
 * `staleTime` would freeze the number for the whole foreground session;
 * code review found exactly that, 2026-08-31).
 */
export function useWaitingCount(): number {
  const { client } = useMote();
  const sessions = useSessions();
  const foreground = useForeground();
  const summary = useQuery({
    enabled: Boolean(client),
    queryKey: ["summary"],
    queryFn: () => client?.summary(),
    staleTime: 2000,
    retry: false, // 404 on older instances is the fallback signal, not an error to fight
    refetchInterval: () => pollIntervalMs({ foreground, hasActivity: hasActivity(sessions.data ?? []) }) ?? false,
    refetchIntervalInBackground: false,
  });
  return summary.data?.waiting ?? waitingCount(sessions.data ?? []);
}
