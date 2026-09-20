import { getRequestlessContext } from "@/lib/context.js";
import { type LiveEvent, subscribeLive } from "@/services/live-bus.js";
import { logger } from "@/utils/logger.js";
import { recipientTopics } from "@/ws/live-topics.js";

/**
 * How long changes to one subshell are collected before a frame goes out.
 *
 * A single domain act touches a row several times — a launch writes the row,
 * mints its token and patches it post-spawn — and announcing each would send
 * a browser four frames describing one thing. Measured before this window
 * existed: creating one subshell produced exactly that.
 *
 * 40 ms is below the threshold where a person reads the UI as lagging, and it
 * is nothing beside the 1.5 s cadence this design removed. It also makes the
 * announce points forgiving: a service may announce liberally at act
 * boundaries without the wire showing it.
 */
export const LIVE_COALESCE_MS = 40;

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
export function startLivePublisher(deps: { target: LivePublisherTarget; coalesceMs?: number }): () => void {
  const window = deps.coalesceMs ?? LIVE_COALESCE_MS;
  /** id → the event to send for it once the window closes. */
  const pending = new Map<string, LiveEvent>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const event of batch) {
      void publishEvent(deps.target, event).catch((err: unknown) => {
        logger.withError(err).warn("live publisher: failed to broadcast an event");
      });
    }
  };

  const unsubscribe = subscribeLive((event: LiveEvent) => {
    // A DELETION is terminal and outranks any change queued for the same id:
    // the row is gone, so a `subshell` frame resolved after it would find
    // nothing and send nothing, leaving the client holding a row that no
    // longer exists. The reverse never happens — nothing changes a deleted row.
    const queued = pending.get(event.id);
    if (queued?.kind === "subshell.deleted") return;
    pending.set(event.id, event);
    // Leading-edge timer, not a per-event debounce: a row written to steadily
    // must not have its frame postponed forever.
    if (!timer) timer = setTimeout(flush, window);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
    pending.clear();
  };
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
