import { useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { useSubshellsList } from "@/hooks/use-subshells";
import type { SubshellView } from "@/types/subshell";

/**
 * Live subshell list for the home page — the thin READ end of the root feed.
 *
 * The socket transport lives in `LiveSubshellsFeedProvider` in
 * `__root.tsx` (spec 2026-09-03 sidebar-quickadd §6); this hook now just
 * merges the provider's most recent frame with the REST query (initial load,
 * older backends without the live socket, and the invalidation-driven refresh).
 * The returned shape is unchanged.
 */
export function useLiveSubshells(): {
  subshells: SubshellView[];
  connected: boolean;
  isLoading: boolean;
  /** True when the REST list failed AND the SSE stream has delivered nothing */
  isError: boolean;
  /** Re-runs the REST list fetch (the retry affordance for `isError`) */
  refetch: () => Promise<unknown>;
} {
  const rest = useSubshellsList();
  const feed = useLiveSubshellsFeed();
  // `isError` is deliberately gated on `lastList === null`: once the stream
  // has delivered a list, the page has current data no matter what the REST
  // fallback did, and calling that an error would be a lie of its own.
  return {
    subshells: feed.lastList ?? rest.data ?? [],
    connected: feed.connected,
    isLoading: rest.isLoading && feed.lastList === null,
    isError: rest.isError && feed.lastList === null,
    refetch: rest.refetch,
  };
}
