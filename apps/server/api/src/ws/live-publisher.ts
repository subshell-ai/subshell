import type { LiveServerFrame } from "@internal/subshell-protocol";
import { getRequestlessContext } from "@/lib/context.js";
import { type LiveEvent, subscribeLive } from "@/services/live-bus.js";
import type { SubshellsService } from "@/services/subshells.service.js";
import { logger } from "@/utils/logger.js";
import { levelChangedTopics, recipientTopics, revocationTopics } from "@/ws/live-topics.js";

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

/**
 * A frame this module may publish — the shared envelope with its SNAPSHOT
 * half closed off, since a snapshot is per-viewer and can only be sent down
 * one socket. The row type is derived from the service method that builds it,
 * so dropping a field there is a type error here.
 */
type LiveBroadcastFrame = LiveServerFrame<never, Awaited<ReturnType<SubshellsService["viewsForBroadcast"]>>[number]>;

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

  /**
   * Windows are drained ONE AT A TIME, and each window's events in order.
   *
   * Resolving an event is several awaited reads, so firing a window's events
   * in parallel — and the next window's before this one settled — lets a
   * broadcast for a row land after a LATER broadcast for the same row, leaving
   * every client on the stale version until something else happens to it. The
   * chain costs nothing at this volume and removes the reordering entirely.
   */
  let draining: Promise<void> = Promise.resolve();
  const flush = (): void => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    draining = draining.then(async () => {
      for (const event of batch) {
        try {
          await publishEvent(deps.target, event);
        } catch (err) {
          logger.withError(err).warn("live publisher: failed to broadcast an event");
        }
      }
    });
  };

  const unsubscribe = subscribeLive((event: LiveEvent) => {
    // Events for one id do not merely replace each other — two of the three
    // kinds carry something the others cannot reconstruct, so the window has a
    // precedence order: deleted > shares-changed > changed.
    //
    // A DELETION is terminal: the row is gone, so a `subshell` frame resolved
    // after it would find nothing and send nothing, leaving the client holding
    // a row that no longer exists. Nothing changes a deleted row, so this
    // never needs undoing.
    //
    // A SHARES-CHANGE carries `before`, the only record of who used to see the
    // row — and an ordinary change lands on the same id constantly (a sweep
    // tick, an attention self-report, a harness-session write). Overwriting it
    // dropped the revocation entirely, silently, inside 40 ms. It loses
    // nothing to keep: resolving a shares-change re-reads and re-broadcasts
    // the row exactly as a change would. When two shares-changes land in one
    // window the EARLIEST `before` is the true "used to", so the first wins.
    const queued = pending.get(event.id);
    if (queued?.kind === "subshell.deleted") return;
    if (queued?.kind === "subshell.shares-changed" && event.kind !== "subshell.deleted") return;
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
  if (event.kind === "node.changed") return; // node frames arrive with the nodes half

  if (event.kind === "subshell.deleted") {
    // The row and its grants are gone, so the recipient set comes from the
    // EVENT — which carries the shares read before the delete cascaded them.
    // Deriving it from the owner alone reached the owner and the admins only,
    // and left a shared subshell sitting on every grantee's dashboard until
    // they reconnected. Telling someone about an id they never held is
    // harmless by design (§4.2): the frame says "you cannot see this", which
    // is true whether the row was deleted, unshared, or never visible.
    broadcast(target, recipientTopics({ ownerUserId: event.ownerId, shares: event.shares }), {
      type: "subshell-gone",
      id: event.id,
    });
    return;
  }

  // Whoever the row USED to reach. Derived from the event, so it survives
  // anything going wrong with the reads below — a revocation that failed to
  // send would leave someone looking at a subshell they no longer may.
  const revokedTopics = event.kind === "subshell.shares-changed" ? recipientTopics(event.before) : [];

  /**
   * What the reads below managed to establish.
   *
   * **An empty `currentTopics` is not the same fact as "this row reaches
   * nobody", and conflating them publishes a removal for a row that exists.**
   * A failed read left it `[]`, which made every revoked topic look lost —
   * `live:admins` included, since it is in both sets on every branch — so a
   * transient database hiccup during a share edit told every admin and the
   * owner that a live subshell was gone, stickily. That is the same mistake
   * as the topic-name difference this module already learned once.
   */
  let resolved: "row" | "missing" | "failed" = "failed";
  let currentTopics: string[] = [];
  let levelChanged: string[] = [];
  try {
    const { repos, services } = getRequestlessContext();
    const row = await repos.subshells.findById(event.id);
    if (!row) {
      // Raced a delete; that event carries the owner and its shares and does
      // the honest thing. Nothing to say here.
      resolved = "missing";
    } else {
      const shares = (await repos.subshellShares.listForSubshells([event.id])).get(event.id) ?? [];
      currentTopics = recipientTopics({ ownerUserId: row.userId, shares });
      if (event.kind === "subshell.shares-changed") {
        levelChanged = levelChangedTopics({ ownerUserId: row.userId, before: event.before.shares, after: shares });
      }
      // `viewsForBroadcast` is the shared half by construction — it drops the
      // per-viewer `access` (one payload, every subscriber) and captures no
      // pane, so a screen never rides a topic.
      // The shares just read, handed on: the exposure fields this renders are
      // derived from the same rows the topics were.
      const [view] = await services.subshells.viewsForBroadcast([row], new Map([[event.id, shares]]));
      resolved = "row";
      if (view) broadcast(target, currentTopics, { type: "subshell", id: event.id, row: view });
    }
  } catch (err) {
    // Reported, not swallowed — and the revocation below still goes out, but
    // as a question rather than an assertion.
    logger.withError(err).warn("live publisher: could not resolve a changed row");
  }

  if (resolved === "missing") return;

  // Told LAST, and by REACHABILITY rather than by name: `everyone` subsumes
  // the user topics, so a plain set-difference names topics whose subscribers
  // still hold the row — see `revocationTopics`, which is where that is
  // reasoned about and exhaustively diffed.
  //
  // When the reads FAILED, every revoked topic is asked rather than told:
  // asking is safe under any answer, and a viewer who really did lose the row
  // learns it from the snapshot they fetch in reply.
  const { gone, recheck } =
    resolved === "row" ? revocationTopics(revokedTopics, currentTopics) : { gone: [], recheck: revokedTopics };
  if (gone.length > 0) broadcast(target, gone, { type: "subshell-gone", id: event.id });
  // A level change is asked about too: the row went out carrying no `access`
  // (it cannot), so only a per-viewer resolve can move a grantee from `edit`
  // to `view`.
  const asked = [...new Set([...recheck, ...levelChanged])];
  if (asked.length > 0) broadcast(target, asked, { type: "subshell-recheck", id: event.id });
}

/** One serialization, published to each topic. */
function broadcast(target: LivePublisherTarget, topics: string[], frame: LiveBroadcastFrame): void {
  const payload = JSON.stringify(frame);
  for (const topic of topics) target.publish(topic, payload);
}
