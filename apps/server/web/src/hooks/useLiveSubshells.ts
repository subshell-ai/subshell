import { useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { useSubshellsList } from "@/hooks/use-subshells";
import type { SubshellView } from "@/types/subshell";

/**
 * Live subshell list for the home page — the thin READ end of the root feed.
 *
 * The socket transport lives in `LiveSubshellsFeedProvider` in
 * `__root.tsx` (spec 2026-09-03 sidebar-quickadd §6). The list itself comes
 * from the REST query and ONLY from it, because the feed writes every frame
 * into that same cache key — so there is one source, not two that agree most
 * of the time.
 *
 * **It used to return `feed.lastList ?? rest.data`, and that shadowing left a
 * deleted subshell on the home page forever.** Any mutation's
 * `invalidateQueries` refetches the list and writes the CACHE; the feed's
 * `lastList` is a separate copy it updates only when IT commits. Closing a
 * subshell did both at once: the refetch removed the row from the cache, and
 * the `subshell-gone` frame that followed found nothing left to drop and
 * returned early — so `lastList` kept the row, and won. The old 1.5 s cadence
 * hid this by re-sending the whole list; with the feed event-driven there is
 * nothing to correct it, which is what made a card outlive its subshell
 * (caught by the e2e node spec, 2026-09-20).
 *
 * `lastList` still answers ONE question, and it is not "what is the list": it
 * is whether the socket has ever delivered, which is what keeps a failed REST
 * fallback from being reported as an error on a page that has live data.
 */
export function useLiveSubshells(): {
  subshells: SubshellView[];
  connected: boolean;
  isLoading: boolean;
  /** True when the REST list failed AND the live socket has delivered nothing */
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
    subshells: rest.data ?? [],
    connected: feed.connected,
    isLoading: rest.isLoading && feed.lastList === null,
    isError: rest.isError && feed.lastList === null,
    refetch: rest.refetch,
  };
}
