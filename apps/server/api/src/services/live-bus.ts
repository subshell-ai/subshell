import { EventEmitter } from "node:events";
import type { SubshellSharePermission } from "@/db/types/subshell-shares.db-types.js";
import { logger } from "@/utils/logger.js";

/**
 * One thing that changed, named by id — never a rendered view.
 *
 * A publisher says "this id changed" and stops there; WHAT that means for a
 * given viewer is resolved per subscriber, through the same sharing-aware
 * path `GET /api/subshells` uses (see `ws/live-ws.ts`). Publishing a row
 * instead would force every mutation site to know the viewer set, which is
 * the shape in which an authorization bug becomes possible — and the 2026-09-03
 * live report is the precedent: the SSE feed was backed by the owner-only
 * manager list while REST answered sharing-aware, and an admin's rows
 * flickered in and out.
 */
export type LiveEvent =
  | { kind: "subshell.changed"; id: string }
  /** The row is gone, so its owner rides along — nothing can look it up after. */
  | { kind: "subshell.deleted"; id: string; ownerId: string }
  /**
   * The GRANTS changed, and the recipient set therefore shrank as well as
   * grew. Carries the access the row had BEFORE the write, because that is
   * the only way anyone can still be told they lost it: recipients computed
   * after the write reach everyone except the person it concerns (spec §4.2).
   */
  | {
      kind: "subshell.shares-changed";
      id: string;
      before: { ownerUserId: string; shares: { granteeUserId: string | null; permission: SubshellSharePermission }[] };
    }
  | { kind: "node.changed"; id: string };

/**
 * In-process change bus for the dashboard's live feed (spec 2026-09-19).
 *
 * Shaped after `services/channels/post-bus.ts`, the only other emitter in the
 * API, and with the same deliberate absences: no persistence and no
 * cross-process fan-out. The subshell backend is one process, and a missed
 * event costs a subscriber nothing durable — every socket resyncs from a full
 * snapshot on connect and on reconnect, so the snapshot, not an event log, is
 * what makes a client correct.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open dashboard socket; unbounded by design

/** The single emitter channel — subscribers filter by `kind`, not by event name. */
const CHANNEL = "live";

/**
 * Announces a change to every subscriber.
 *
 * Callers are mutation paths (create, terminate, restart, rename, share) and
 * the reconcile sweep, so this must never throw into them: a browser socket
 * having a bad time cannot become a failed terminate. Isolation is applied at
 * SUBSCRIBE time (see {@link subscribeLive}) rather than here, because
 * `EventEmitter.emit` invokes listeners synchronously and one throwing
 * listener would otherwise rob the listeners after it in the list, not just
 * the publisher.
 */
export function publishLive(event: LiveEvent): void {
  bus.emit(CHANNEL, event);
}

/**
 * Subscribes to every change on the bus.
 *
 * The registered listener is a WRAPPER that swallows and logs whatever `cb`
 * throws — that is what keeps one bad subscriber from reaching the publisher
 * or its peers.
 *
 * @param cb - called with each event; its exceptions are contained
 * @returns an unsubscribe function, safe to call more than once
 */
export function subscribeLive(cb: (event: LiveEvent) => void): () => void {
  const listener = (event: LiveEvent): void => {
    try {
      cb(event);
    } catch (err) {
      logger.withError(err).warn("live-bus: subscriber threw; event dropped for it");
    }
  };
  bus.on(CHANNEL, listener);
  let off = false;
  return () => {
    if (off) return;
    off = true;
    bus.off(CHANNEL, listener);
  };
}
