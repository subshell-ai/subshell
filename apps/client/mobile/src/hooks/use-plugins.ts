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
    // Networks are filtered out HERE rather than at the chips, because there
    // is no screen on a phone where one belongs: joining a network is an act
    // on the server's own machine, and this catalog is read for one purpose —
    // which agent to launch. A network row reaching the Agent chips would be
    // an unlaunchable choice.
    queryFn: async () => (await client?.plugins())?.filter((plugin) => plugin.type !== "network"),
    staleTime: 60_000,
  });
}
