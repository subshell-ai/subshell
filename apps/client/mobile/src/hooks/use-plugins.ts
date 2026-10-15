import { useQuery } from "@tanstack/react-query";
import { isLaunchVisible } from "@/lib/plugin-visibility";
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
    // Networks and `pickable: false` plugins are filtered out HERE rather
    // than at the chips, because there is no screen on a phone where either
    // belongs: joining a network is an act on the server's own machine, and
    // a plugin that refuses the pickers (SSH: a bare launch dies without a
    // destination) would be a chip that starts a dying pane. The web mirrors
    // this in `buildAgentOptions`; change one, change both.
    queryFn: async () => (await client?.plugins())?.filter(isLaunchVisible),
    staleTime: 60_000,
  });
}
