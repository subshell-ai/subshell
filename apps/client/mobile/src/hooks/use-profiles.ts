import { useQuery } from "@tanstack/react-query";
import { useSubshell } from "@/providers/subshell-provider";

/** Profiles for the picker — static enough that 60 s freshness is fine. */
export function useProfiles() {
  const { client } = useSubshell();
  return useQuery({
    enabled: Boolean(client),
    queryKey: ["profiles"],
    queryFn: () => client?.profiles(),
    staleTime: 60_000,
  });
}
