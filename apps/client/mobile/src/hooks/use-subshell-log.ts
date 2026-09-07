import { useQuery } from "@tanstack/react-query";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * The Log tab source (spec §Rendering): the already-stripAnsi-ed native tail.
 * Fetched when the Log tab is first opened, then on pull only — it is a byte
 * tail, not a stream, so the 3 s loop would be theatre.
 */
export function useSubshellLog(id: string, enabled: boolean) {
  const { client } = useSubshell();
  return useQuery({
    enabled: Boolean(client && id && enabled),
    queryKey: ["subshell-log", id],
    queryFn: () => client?.subshellLog(id),
    staleTime: 30_000,
  });
}
