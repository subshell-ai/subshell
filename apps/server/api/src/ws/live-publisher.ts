import { getRequestlessContext } from "@/lib/context.js";
import { type LiveEvent, subscribeLive } from "@/services/live-bus.js";
import { logger } from "@/utils/logger.js";
import { recipientTopics } from "@/ws/live-topics.js";

/** What this module needs of Bun's server handle — just the broadcast. */
export interface LivePublisherTarget {
  publish(topic: string, data: string): unknown;
}

/**
 * Turns bus events into topic broadcasts (spec 2026-09-19 §4.1a).
 *
 * One read per event and NOTHING per connected viewer: the recipient set is
 * derived from the row's owner and its shares, so a hundred open dashboards
 * cost the same as one. That is the whole reason the fan-out is topics rather
 * than a loop that resolves visibility per socket.
 *
 * **The frame it publishes is viewer-INDEPENDENT**, which is forced by the
 * transport: one payload reaches every subscriber, so it cannot carry the
 * per-viewer `access` stamp `listSubshells` applies. Clients keep the access
 * they hold from their snapshot; a share or role change is a separate,
 * targeted act (§4.1a).
 *
 * @param deps.target - the server handle to broadcast through
 * @returns an unsubscribe function; the boot path holds it for the process life
 */
export function startLivePublisher(deps: { target: LivePublisherTarget }): () => void {
  return subscribeLive((event: LiveEvent) => {
    void publishEvent(deps.target, event).catch((err: unknown) => {
      // Never throws into the bus, which would reach the mutation that
      // published — a failed broadcast must not become a failed terminate.
      logger.withError(err).warn("live publisher: failed to broadcast an event");
    });
  });
}

/**
 * Resolves one event's recipients and broadcasts to them.
 *
 * A deletion publishes to the recipient set the row had while it existed —
 * computing it afterwards would reach nobody, since the row and its shares are
 * gone. That is why `subshell.deleted` carries its `ownerId` on the bus.
 */
async function publishEvent(target: LivePublisherTarget, event: LiveEvent): Promise<void> {
  const { repos, services } = getRequestlessContext();

  if (event.kind === "subshell.deleted") {
    // Shares are gone with the row, so the owner and the admins are all that
    // can be derived. A grantee learns from their next snapshot; telling
    // everyone would be a broadcast of an id they may never have seen.
    const topics = recipientTopics({ ownerUserId: event.ownerId, shares: [] });
    broadcast(target, topics, { type: "subshell-gone", id: event.id });
    return;
  }

  if (event.kind === "node.changed") return; // node frames arrive with the nodes half

  const row = await repos.subshells.findById(event.id);
  if (!row) {
    // Raced with a delete. The deletion event carries the owner and will do
    // the honest thing; guessing a recipient set from nothing would not.
    return;
  }
  const shares = (await repos.subshellShares.listForSubshells([event.id])).get(event.id) ?? [];
  const topics = recipientTopics({ ownerUserId: row.userId, shares });
  // `viewsForBroadcast` is the shared half by construction — it drops the
  // per-viewer `access` rather than leaving a default to be believed.
  const [view] = await services.subshells.viewsForBroadcast([row]);
  if (!view) return;
  broadcast(target, topics, { type: "subshell", id: event.id, row: view });
}

/** One serialization, published to each topic. */
function broadcast(target: LivePublisherTarget, topics: string[], frame: unknown): void {
  const payload = JSON.stringify(frame);
  for (const topic of topics) target.publish(topic, payload);
}
