import { apiFetch, isNetworkError } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/**
 * Whether the daemon serving this page is currently unreachable, and the
 * refetch-everything when it returns.
 *
 * This dashboard is served BY THE node daemon, so a restart, an update, or a
 * service stop takes the exact process answering these fetches down with it.
 * That outage is not an error to report — it is the expected middle of the flow
 * the operator just started. The page's own queries already retry
 * unbounded on a `NetworkError` (see `lib/query-client`); this adds the two
 * things the app wants above that:
 *
 * - a SINGLE down signal to raise the reconnect overlay from, and
 * - a full invalidation the moment the node answers again, so every card
 *   re-reads the machine that just came back rather than showing the frozen
 *   bytes it held when it went away.
 *
 * It is a probe query, not a reader: `retry: 0` so an outage is visible as a
 * `NetworkError` on the first poll (the unbounded-retry policy is the page
 * queries' job and would hide the transition here), a short interval so the
 * return is noticed promptly, and its result is discarded — only its error
 * state and its success-after-error matter.
 */
export function useReconnect(): boolean {
  const queryClient = useQueryClient();
  const [down, setDown] = useState(false);
  const wasDown = useRef(false);

  const { error } = useQuery({
    queryKey: ["reachability"],
    // `/api/self` on purpose, not `/api/nodes/self`: the probe only needs to
    // know whether the daemon answers, and `/api/self` is config-only, while
    // the node view runs `liveSubshellCount` — one `tmux has-subshell` spawn
    // per meta record, every 1.5 s here, on top of the pages' own 5 s poll.
    queryFn: () => apiFetch<unknown>("/api/self"),
    refetchInterval: 1_500,
    retry: 0,
    staleTime: 0,
  });

  useEffect(() => {
    const unreachable = isNetworkError(error);
    setDown(unreachable);
    // The edge, not the level: coming back is what invalidates. On the first
    // success after an outage the queries the pages hold are stale-by-
    // definition (they describe a process that has since restarted), so
    // refetch everything rather than only the node detail.
    if (wasDown.current && error === null) void queryClient.invalidateQueries();
    wasDown.current = unreachable;
  }, [error, queryClient]);

  return down;
}
