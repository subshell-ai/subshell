import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { NodeStatus } from "@/db/types/nodes.db-types.js";
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
 * It reads over the shared `db` handle directly rather than through
 * `getRequestlessContext`, and that edge is load-bearing, not tidiness: this
 * module sits in `node-registry`'s import graph (the eviction seam calls
 * {@link projectNodeOffline}), and the requestless context pulls in the
 * service graph, which pulls the registry right back. The repositories are
 * stateless over the one Kysely handle the context would hand out, so the
 * direct construction answers the same question the singleton does.
 *
 * @param nodeId - the node whose reachability changed
 */
export function announceNodePresence(nodeId: string): void {
  void (async () => {
    try {
      const ids = await new SubshellsRepository(db).listRunningIdsOnNode(nodeId);
      // One event per row, coalesced per id by the publisher — the rows are
      // independent and each resolves to its own recipient set.
      for (const id of ids) publishLive({ kind: "subshell.changed", id });
    } catch (err) {
      logger.withError(err).warn(`node presence: could not announce the subshells on ${nodeId}`);
    }
  })();
}

/**
 * Project a node's row `offline` and re-announce the panes that just lost
 * their machine — the two visible halves of "this node is gone", owed by
 * whatever forced it.
 *
 * Mirrors `holdRefusedNode`'s projection (node-ws-handler): the hold
 * cannot wait for a close event that never comes, and neither can an
 * eviction — `disconnectNode` detaches the registry entry BEFORE the
 * socket's close lands, so the close handler's `current.ws === mine` guard
 * correctly skips and its projection would never run. Without this the row
 * read online and the feed claimed healthy panes until the stale sweep.
 *
 * The status write is AWAITED: the eviction's caller answers in a world
 * where the node is offline, and by then the row must say so (that is what
 * makes "the Nodes page flips at once, no timer waiting" testable). The
 * announce stays best-effort, as everywhere. A THROWING write is absorbed —
 * the eviction already happened and must not read as a failed revocation
 * because a projection row could not be written; a row left stale by one
 * sweep is the degradation, not the contract.
 *
 * @param nodeId - the node whose socket was just force-evicted or held out
 */
export async function projectNodeOffline(nodeId: string): Promise<void> {
  try {
    await new NodesRepository(db).setStatus(nodeId, "offline" satisfies NodeStatus);
  } catch (err) {
    logger.withError(err).warn(`node presence: could not project ${nodeId} offline`);
  }
  announceNodePresence(nodeId);
}
