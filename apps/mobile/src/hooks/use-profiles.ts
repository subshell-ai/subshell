import { useQuery } from "@tanstack/react-query";
import { useMote } from "@/providers/subshell-provider";

/** Profiles for the picker — static enough that 60 s freshness is fine. */
export function useProfiles() {
  const { client } = useMote();
  return useQuery({
    enabled: Boolean(client),
    queryKey: ["profiles"],
    queryFn: () => client?.profiles(),
    staleTime: 60_000,
  });
}
