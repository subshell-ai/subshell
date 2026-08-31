import { useQuery } from "@tanstack/react-query";
import { useForeground } from "@/hooks/use-foreground";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import { useMote } from "@/providers/mote-provider";

/**
 * One session on the same cadence as the list (spec §Rendering: session truth
 * comes from the polled list; the detail pill rides the same policy — including
 * the background stop, which hardcoded `foreground: true` used to ignore).
 */
export function useSession(id: string) {
  const { client } = useMote();
  const foreground = useForeground();
  return useQuery({
    enabled: Boolean(client && id),
    queryKey: ["session", id],
    queryFn: () => client?.session(id),
    refetchInterval: (q) =>
      pollIntervalMs({ foreground, hasActivity: hasActivity(q.state.data ? [q.state.data] : []) }) ?? false,
    refetchIntervalInBackground: false,
  });
}
