import { useQuery } from "@tanstack/react-query";
import { useSubshell } from "@/providers/subshell-provider";

/** Presets for the optional chip row — static enough that 60 s freshness is fine. */
export function usePresets() {
  const { client } = useSubshell();
  return useQuery({
    enabled: Boolean(client),
    queryKey: ["presets"],
    queryFn: () => client?.presets(),
    staleTime: 60_000,
  });
}
