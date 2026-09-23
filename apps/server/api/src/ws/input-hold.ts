/**
 * The plane-side hold for a failed plane→node input write (spec 2026-09-21
 * Wave D).
 *
 * Wave A's premise — "while the socket is alive, TCP ordering means an
 * unacked frame is 'not yet', never 'lost'" — holds for the BROWSER↔PLANE
 * leg only. The plane→node leg fails INDEPENDENTLY while the browser socket
 * lives: the daemon restarts, a mesh blip drops the agent socket, or an
 * `input` command times out. `handleSubshellMessage`'s write then rejects,
 * the old `.catch(logFailure)` dropped the keystroke, no ack fired, and no
 * dedupe commit happened — so the client's own retry machinery (which only
 * ships on reconnect or ack-drain) never moved again: every later keystroke
 * took the backpressure path and waited for an ack that would never come.
 * This module closes that half: the failed frame is HELD, keyed
 * (node, subshell, session, id) beside the dedupe window's own keying, and
 * RE-FIRED through the same `launcher.sendInput` path when the node's
 * connection is live again.
 *
 * The four design rules, each load-bearing:
 *
 * - **Scoped to the attached /ws session.** The hold lives exactly as long
 *   as the browser socket that produced the frame (`dropInputHolds` from
 *   `cleanupSubshellWs`); a held frame's client still
 *   carries its own backlog, so its reconnect re-send is the safety net for
 *   anything this hold drops — never a loss, only the documented
 *   at-least-once duplicate.
 * - **Re-fire runs the SAME path as a fresh write.** The drain reads the
 *   session's launcher/socket/subshell off `ws.data` at write time and calls
 *   `sendInput` exactly as the message handler does, so the ack and the
 *   dedupe window behave identically. A resolved write commits its id to the
 *   dedupe window BEFORE the ack is sent (that ordering is the message
 *   handler's, unchanged), so a re-send of a write whose ack was lost is
 *   absorbed by the window — the only double-write possible is the
 *   documented one whose result frame never came back.
 * - **A node that stays down just leaves the frames waiting.** There is no
 *   retry timer: the re-fire triggers are the node's `ready` moment (the
 *   node-ws-handler, which calls {@link refireInputHoldsForNode}) and a
 *   new-write arrival (which appends and kicks the drain). The memory bound
 *   is the client's own: a client never holds more than its 512-frame
 *   pending queue (MAX_PENDING in input-queue.ts — 2026-09-22's window +
 *   INFLIGHT_MAX cap moved WHEN frames ship, not how many can wait), and a
 *   re-arriving id never duplicates a hold, so the hold can never exceed
 *   what the client itself is holding.
 * - **A re-fire failure re-enters the hold.** The drain stops at the first
 *   rejection, leaving that frame at the head and every later one behind it;
 *   the next trigger re-enters. No clock anywhere in this module.
 *
 * Ordering: holds re-fire in id order, and because an arrival while holds
 * exist JOINS the queue instead of dispatching past them, no ARRIVING frame
 * is written ahead of a held id. The accepted residual, restated 2026-09-22
 * when the client began pipelining up to INFLIGHT_MAX (8) sent-unacked
 * frames: those frames are dispatched to the node as they arrive, so when
 * one write of an in-flight burst FAILS mid-chain, the siblings the node
 * already queued land before the re-fired head — keystrokes can reorder
 * within one burst on a partial plane→node failure. (The ack-serialized
 * client could already reach this — a multi-chunk fast-path paste or a
 * reconnect resend put several unacked writes on the node's chain — but
 * TYPING could not, because typing kept its whole backlog in the browser;
 * pipelining widened the residual from those two paths to every burst.)
 * Closing it
 * properly means carrying the client id to the node's chain — a protocol
 * change; against this module's own posture (at-least-once, never zero) and
 * the trigger's rarity — a transient per-write failure on a live node's
 * serial chain — reordering-within-a-burst is accepted and stated, not
 * papered over.
 */

import { logger } from "@/utils/logger.js";
import { inputWindowAdd } from "@/ws/input-window.js";
import type { WsSocket } from "@/ws/viewers.js";

/** One held input: the id and the exact bytes the client froze, the socket
 * to ack on a re-fired success, and the ack sender (which encodes in that
 * socket's negotiated mode). */
interface HoldEntry {
  id: number;
  payload: string;
  ws: WsSocket;
  sendAck: () => void;
}

/** One session's holds: the FIFO (id order by construction — client ids are
 * per-session monotonic) plus the drain guard. */
interface SessionHold {
  queue: HoldEntry[];
  draining: boolean;
}

/** nodeId → subshellId → sessionId → holds. Keyed top-down by node because
 * the re-fire trigger is a node event, and the handler has nothing but the
 * node id. */
const holds = new Map<string, Map<string, Map<string, SessionHold>>>();

/**
 * True when this session already holds failed writes. A new arrival must
 * JOIN the queue rather than dispatch past it, or a held id would re-fire
 * after the newer write landed.
 * @param nodeId - The subshell's node
 * @param subshellId - The subshell the session is attached to
 * @param sessionId - The client's attach session id
 * @returns True when the hold queue for that session is non-empty
 */
export function hasHeldInput(nodeId: string, subshellId: string, sessionId: string): boolean {
  const hold = holds.get(nodeId)?.get(subshellId)?.get(sessionId);
  return (hold?.queue.length ?? 0) > 0;
}

/** The arguments a failed write needs to become a hold — exactly what the
 * message handler has in hand at the failure. */
export interface FailedInput {
  /** The subshell's node (the re-fire trigger is that node's `ready`). */
  nodeId: string;
  /** The subshell the session is attached to. */
  subshellId: string;
  /** The client's attach session id (the dedupe window's co-key). */
  sessionId: string;
  /** The client's input id. */
  id: number;
  /** The exact bytes the frame carried (the client froze them at send). */
  payload: string;
  /** The browser socket to ack on a re-fired success. */
  ws: WsSocket;
  /** Sends the `ack` frame for {@link FailedInput.id} to {@link FailedInput.ws}. */
  sendAck: () => void;
}

/**
 * Holds one failed write and kicks the drain. A re-arriving id (the client's
 * reconnect re-send of a frame this module already holds) never duplicates
 * the hold: an id names exactly the bytes the client froze, so the held copy
 * IS the frame. Either way the arrival is a re-fire trigger — a re-send
 * landing on a node that is quietly healthy again should ship, not wait.
 * @param failed - The failed write
 */
export function holdFailedInput(failed: FailedInput): void {
  let subs = holds.get(failed.nodeId);
  if (!subs) {
    subs = new Map();
    holds.set(failed.nodeId, subs);
  }
  let sessions = subs.get(failed.subshellId);
  if (!sessions) {
    sessions = new Map();
    subs.set(failed.subshellId, sessions);
  }
  let hold = sessions.get(failed.sessionId);
  if (!hold) {
    hold = { queue: [], draining: false };
    sessions.set(failed.sessionId, hold);
  }
  if (!hold.queue.some((entry) => entry.id === failed.id)) {
    hold.queue.push({ id: failed.id, payload: failed.payload, ws: failed.ws, sendAck: failed.sendAck });
  }
  drain(hold, failed.sessionId);
}

/**
 * Serial drain of one session's holds: write the head through the session's
 * own launcher, and only a SUCCESS removes it (a failure re-holds it at the
 * head and stops, so a node that is still down is asked once per trigger,
 * not once per frame). Success commits the dedupe window BEFORE the ack —
 * the message handler's own ordering — and acks the exact socket that sent
 * the frame.
 *
 * The drain is re-entrant-safe: a second trigger while one is running
 * returns, and the running loop sees any entry appended behind it. There is
 * deliberately no post-loop re-kick: an append can only land between awaits,
 * where the loop's own next iteration sees it, and a drain that exited
 * through the catch must NOT re-enter on its own (that would poll a down
 * node once per microtask forever).
 *
 * @param hold - The session's holds
 * @param sessionId - The session id, for the dedupe-window commit
 */
function drain(hold: SessionHold, sessionId: string): void {
  if (hold.draining) return;
  hold.draining = true;
  void (async () => {
    try {
      while (hold.queue.length > 0) {
        const entry = hold.queue[0];
        // Live off the socket's attach state, so the re-fire is the SAME call
        // a fresh write would make — never a stale copy of the launcher the
        // frame originally failed on.
        const data = entry.ws.data;
        await data.launcher.sendInput(data.socket, data.subshellId, entry.payload);
        hold.queue.shift();
        inputWindowAdd(data.subshellId, sessionId, entry.id);
        entry.sendAck();
      }
    } catch (err) {
      logger.withError(err).debug(`ws input re-fire held (session ${sessionId.slice(0, 8)}…): node still down`);
    } finally {
      hold.draining = false;
    }
  })();
}

/**
 * Re-fires every hold on one node, in id order per session. Called from the
 * node-ws-handler's `ready` case — the moment the node's connection is live
 * again — and fire-and-forget there by the same rule as its neighbors: a
 * hold must never be the reason a handshake did not complete, and a failure
 * inside the drain re-holds by itself.
 * @param nodeId - The node that just became reachable
 */
export function refireInputHoldsForNode(nodeId: string): void {
  const subs = holds.get(nodeId);
  if (!subs) return;
  for (const sessions of subs.values()) {
    for (const [sessionId, hold] of sessions) {
      if (hold.queue.length > 0) drain(hold, sessionId);
    }
  }
}

/**
 * Drops one browser session's holds. Called from `cleanupSubshellWs`: the
 * session is gone, its backlog rides the client's own reconnect re-send, and
 * a hold that outlived its socket would ack a dead peer. A drain that is
 * mid-write on the head finishes that one write (the bytes did reach the
 * pane, so the window commit stays honest) and its ack send is absorbed by
 * the closed socket; the emptied queue makes its next loop check exit.
 * @param nodeId - The subshell's node
 * @param subshellId - The subshell the session was attached to
 * @param sessionId - The client's attach session id
 */
export function dropInputHolds(nodeId: string, subshellId: string, sessionId: string): void {
  const subs = holds.get(nodeId);
  const sessions = subs?.get(subshellId);
  const hold = sessions?.get(sessionId);
  if (!hold || !subs || !sessions) return;
  hold.queue = [];
  sessions.delete(sessionId);
  if (sessions.size === 0) {
    subs.delete(subshellId);
    if (subs.size === 0) holds.delete(nodeId);
  }
}

/**
 * Drops every hold. Only for tests, which reuse subshell ids and sessions;
 * a surviving hold would re-fire the previous case's keystroke into the next
 * one's pane. @internal
 */
export function resetInputHoldsForTests(): void {
  holds.clear();
}
