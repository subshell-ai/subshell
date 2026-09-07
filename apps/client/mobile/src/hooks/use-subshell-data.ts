import { useQuery } from "@tanstack/react-query";
import { polledInterval } from "@/hooks/polled-interval";
import { subshellKey } from "@/hooks/query-keys";
import { useForeground } from "@/hooks/use-foreground";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * One subshell on the same cadence as the list (spec §Rendering: subshell truth
 * comes from the polled list; the detail pill rides the same policy — including
 * the background stop, which hardcoded `foreground: true` used to ignore).
 */
export function useSubshellData(id: string) {
  const { client } = useSubshell();
  const foreground = useForeground();
  return useQuery({
    enabled: Boolean(client && id),
    queryKey: subshellKey(id),
    queryFn: () => client?.subshell(id),
    refetchInterval: (q) => polledInterval(foreground, () => (q.state.data ? [q.state.data] : undefined)),
    refetchIntervalInBackground: false,
  });
}
