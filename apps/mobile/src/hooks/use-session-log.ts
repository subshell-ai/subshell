import { useQuery } from "@tanstack/react-query";
import { useMote } from "@/providers/subshell-provider";

/**
 * The Log tab source (spec §Rendering): the already-stripAnsi-ed native tail.
 * Fetched when the Log tab is first opened, then on pull only — it is a byte
 * tail, not a stream, so the 3 s loop would be theatre.
 */
export function useSessionLog(id: string, enabled: boolean) {
  const { client } = useMote();
  return useQuery({
    enabled: Boolean(client && id && enabled),
    queryKey: ["session-log", id],
    queryFn: () => client?.sessionLog(id),
    staleTime: 30_000,
  });
}
