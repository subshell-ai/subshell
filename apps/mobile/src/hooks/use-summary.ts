import { useQuery } from "@tanstack/react-query";
import { useSessions } from "@/hooks/use-sessions";
import { waitingCount } from "@/lib/session-order";
import { useMote } from "@/providers/mote-provider";

/**
 * Badge number (spec §Screens): the summary endpoint when the instance has
 * it, else derived from the same polled list — never a second network loop.
 */
export function useWaitingCount(): number {
  const { client } = useMote();
  const sessions = useSessions();
  const summary = useQuery({
    enabled: Boolean(client),
    queryKey: ["summary"],
    queryFn: () => client?.summary(),
    staleTime: 2000,
    retry: false, // 404 on older instances is the fallback signal, not an error to fight
  });
  return summary.data?.waiting ?? waitingCount(sessions.data ?? []);
}
