import { useQuery } from "@tanstack/react-query";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * The instance plugin catalog for the Agent chips (spec 2026-09-10) — admin
 * installs/uninstalls are rare, so 60 s freshness is fine; the 409 at submit
 * covers the race either way.
 */
export function usePlugins() {
  const { client } = useSubshell();
  return useQuery({
    enabled: Boolean(client),
    queryKey: ["plugins"],
    queryFn: () => client?.plugins(),
    staleTime: 60_000,
  });
}
