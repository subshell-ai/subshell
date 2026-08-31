import { useQuery } from "@tanstack/react-query";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import { useMote } from "@/providers/mote-provider";

/**
 * One session on the same cadence as the list (spec §Rendering: session truth
 * comes from the polled list; the detail pill rides the same policy).
 */
export function useSession(id: string) {
  const { client } = useMote();
  return useQuery({
    enabled: Boolean(client && id),
    queryKey: ["session", id],
    queryFn: () => client?.session(id),
    refetchInterval: (q) =>
      pollIntervalMs({ foreground: true, hasActivity: hasActivity(q.state.data ? [q.state.data] : []) }) ?? false,
  });
}
