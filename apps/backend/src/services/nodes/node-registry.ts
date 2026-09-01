import { NODE_CLOSE_SUPERSEDED } from "@internal/session-protocol";
import type { NodeRpcError } from "./node-rpc.js";

/**
 * Live-connection registry for enrolled agent nodes (spec 2026-08-31 §5.3).
 * A module-scope `nodeId → NodeConnection` map — the single source of truth
 * for "is this node reachable right now", shared by the `/ws/node` handler
 * (who attaches/detaches) and `node-rpc.ts` (who sends and correlates).
 *
 * Newest-wins: when a node re-dials while an old socket is still mapped, the
 * OLD socket is closed with {@link NODE_CLOSE_SUPERSEDED} and flagged `closing`
 * before the new one is installed. The flag plus the identity guard in
 * {@link detachConnection} defuse the classic race where the old socket's
 * `close` event fires AFTER the new attach and would otherwise evict the
 * fresh entry.
 *
 * Deliberately absent: the inbound jti replay LRU. That belongs to the WS
 * handler (per-NODE, shared across every connection the node makes — spec §4);
 * outbound commands need no replay state, and `seq` here is a per-CONNECTION
 * counter that restarts at 0 on every attach.
 */

/**
 * Close code sent to the superseded socket on a newest-wins replace (spec §5.3).
 * @deprecated Alias of {@link NODE_CLOSE_SUPERSEDED} (hoisted to
 * `@internal/session-protocol` in phase 2 so the agent and the registry share
 * one source of truth). Prefer the protocol constant in new code.
 */
export const REPLACE_CLOSE_CODE = NODE_CLOSE_SUPERSEDED;

/**
 * Close code sent when the node's credential just stopped working — rotate
 * and delete revoke the key while its socket is still mapped (spec §5.4).
 * 4401 mirrors the REST 401 the same dead key would get on an upgrade.
 */
export const REVOKED_CLOSE_CODE = 4401;

/**
 * Minimal structural socket shim — same discipline as `WsSocket` in
 * `ws/session-ws.ts`: only what the registry/RPC actually touches, so tests
 * drive fakes and the Bun ws object satisfies it structurally.
 */
export interface NodeSocket {
  /** Send one text frame (the JSON envelope); returns like Bun's `ws.send`. */
  send(data: string): unknown;
  /** Close the socket with an optional code/reason. */
  close(code?: number, reason?: string): void;
}

/** One in-flight command awaiting its `result` frame. */
export interface PendingEntry {
  /** Settle the owning `sendCommand` promise with the result payload. */
  resolve(data: unknown): void;
  /** Settle it as a failure (clears the timeout first). */
  reject(err: NodeRpcError): void;
  /** Deadline armed when the frame hit the socket; cleared on settle. */
  timer: ReturnType<typeof setTimeout>;
}

/** Live state for exactly one node's current connection. */
export interface NodeConnection {
  /** Node id this socket belongs to (no `node:` prefix). */
  nodeId: string;
  /** The live socket. */
  ws: NodeSocket;
  /**
   * Per-CONNECTION monotonic sequence counter; starts at 0, every command
   * pre-increments it. Restarted per attach — it mirrors the agent's fresh
   * `SeqTracker` and is an ordering hint, NOT the replay defense (spec §4).
   */
  seq: number;
  /** In-flight commands awaiting correlation: `jti → settle handles`. */
  pending: Map<string, PendingEntry>;
  /**
   * True once a newer connection has superseded this one: the socket is being
   * closed on purpose, so its own close-handler teardown must not touch the
   * registry or fail the new connection's pendings.
   */
  closing?: boolean;
  /**
   * Per-connection FIFO mutex. `sendCommand` appends its (async) send step so
   * `seq` assignment and `ws.send` stay in call order despite the await on
   * signing in between — see the invariant note in `node-rpc.ts`.
   */
  sendChain: Promise<void>;
}

const live = new Map<string, NodeConnection>();

/**
 * Install `ws` as the live connection for `nodeId`, newest-wins: an existing
 * connection is flagged `closing` and its socket closed with 4409 first
 * (spec §5.3). A throwing close on the stale socket is swallowed — a dead
 * socket that refuses to die must not block the fresh one.
 * Re-attaching the socket that is ALREADY mapped returns the existing record
 * untouched (no close, no fresh seq, no lost pendings).
 * @param nodeId - node id (no `node:` prefix)
 * @param ws - the freshly authenticated socket
 * @returns the new connection record (seq starts at 0, pendings empty)
 */
export function attachConnection(nodeId: string, ws: NodeSocket): NodeConnection {
  const previous = live.get(nodeId);
  // Same socket re-attached (defensive: duplicate `open` dispatch): keep the
  // existing record — seq, pendings, and identity stay untouched.
  if (previous?.ws === ws) return previous;
  if (previous) {
    previous.closing = true;
    try {
      previous.ws.close(NODE_CLOSE_SUPERSEDED, "replaced by a newer connection for this node");
    } catch {
      // already dead — nothing to close
    }
  }
  const conn: NodeConnection = { nodeId, ws, seq: 0, pending: new Map(), sendChain: Promise.resolve() };
  live.set(nodeId, conn);
  return conn;
}

/**
 * The current connection for `nodeId`, or `undefined` when offline.
 */
export function getLive(nodeId: string): NodeConnection | undefined {
  return live.get(nodeId);
}

/**
 * Remove `nodeId`'s entry ONLY when `ws` is still its current socket — the
 * identity guard is what keeps a superseded socket's late `close` event from
 * evicting the replacement.
 * @returns true when the entry was actually removed
 */
export function detachConnection(nodeId: string, ws: NodeSocket): boolean {
  const current = live.get(nodeId);
  if (!current || current.ws !== ws) return false;
  live.delete(nodeId);
  return true;
}

/** Ids of every node with a live connection (any order). */
export function listOnline(): string[] {
  return [...live.keys()];
}

/**
 * Forcibly evict + close `nodeId`'s live connection — the registry side of
 * credential revocation (rotate-key / delete-node call this AFTER their DB
 * changes, so the socket can never serve on a key that just died, T8 carry).
 * Flags the record `closing` and detaches with the same identity guard the
 * WS close handler uses; a throwing `close()` (already-dead socket) is
 * swallowed — eviction is the point, the close is courtesy. In-flight
 * commands are NOT failed here: the socket's real `close` event still fires
 * and `handleNodeClose` drains exactly THAT record's pendings.
 * @param nodeId - node id (no `node:` prefix)
 * @param code - close code (default {@link REVOKED_CLOSE_CODE})
 * @param reason - close reason sent on the wire
 * @returns true when a live connection existed and was evicted
 */
export function disconnectNode(
  nodeId: string,
  code: number = REVOKED_CLOSE_CODE,
  reason = "node access revoked",
): boolean {
  const conn = live.get(nodeId);
  if (!conn) return false;
  conn.closing = true;
  try {
    conn.ws.close(code, reason);
  } catch {
    // already dead — nothing to close; the eviction below still matters
  }
  return detachConnection(nodeId, conn.ws);
}

/**
 * Empties the registry. Test seam only — production callers must not call
 * this; @internal.
 */
export function resetNodeRegistryForTests(): void {
  live.clear();
}
