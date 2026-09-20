import { getRequestlessContext } from "@/lib/context.js";
import { publishLive } from "@/services/live-bus.js";
import { logger } from "@/utils/logger.js";

/**
 * Re-announces the subshells running on a node whose reachability changed.
 *
 * **A node going away changes every row on it**, and nothing else says so.
 * `nodeOffline` is a field of the broadcast row, and it flips for every
 * subshell on a machine the moment its socket drops — but no write touches
 * those rows, so an event-driven feed has no reason to send anything. The
 * SSE stream this design replaced caught it within 1.5 s purely because it
 * re-sent the whole list on a timer; with that gone, an agent that simply
 * dies leaves its subshells rendering as healthy until the viewer reconnects.
 *
 * So the transition is the announcement. Only RUNNING rows are named: a
 * terminated subshell's `nodeOffline` tells nobody anything, and naming every
 * row would put the whole history of a busy node on the wire twice per
 * reconnect.
 *
 * Best-effort and never awaited by a socket handler: a node's connect and
 * disconnect paths must not fail, or slow, because a dashboard could not be
 * told. The reconnect snapshot is the backstop, exactly as it is for a
 * missing announce anywhere else.
 *
 * @param nodeId - the node whose reachability changed
 */
export function announceNodePresence(nodeId: string): void {
  void (async () => {
    try {
      const { repos } = getRequestlessContext();
      const ids = await repos.subshells.listRunningIdsOnNode(nodeId);
      // One event per row, coalesced per id by the publisher — the rows are
      // independent and each resolves to its own recipient set.
      for (const id of ids) publishLive({ kind: "subshell.changed", id });
    } catch (err) {
      logger.withError(err).warn(`node presence: could not announce the subshells on ${nodeId}`);
    }
  })();
}
