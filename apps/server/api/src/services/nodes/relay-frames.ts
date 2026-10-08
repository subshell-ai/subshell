import type { RelayFrame } from "@internal/subshell-protocol";

/**
 * The plane-side recognition seam for `relay` link frames (spec 2026-10-08
 * §5.1/§5.3) - the single named point between "a decrypted, grammar-validated
 * relay frame arrived on an authenticated node socket" and whoever brokers
 * it. `node-ws-handler.ts` routes here from its event switch; nothing else
 * calls in, and nothing here calls outward.
 *
 * **This is deliberately a stub.** Task 8 (the plane relay broker) replaces
 * the body of {@link onRelayFrame} with the real broker. What is ALREADY
 * decided before a frame reaches this file, and must not be re-decided here:
 * the socket is authenticated (the upgrade chain), the link is encrypted and
 * version-matched at NODE_PROTOCOL_VERSION (the handshake - which is why a
 * pre-18 agent never gets a relay frame routed at all), the frame is
 * well-formed and within SSH_RELAY_FRAME_MAX_BYTES (`parseRelayFrame`, via
 * `parseNodeEvent`), the node is not held, and the socket is not superseded
 * (both guards run upstream in the handler).
 *
 * What Task 8's broker owns, and NOTHING here does:
 * - pair the two live sockets by the frame's routing `ref` against the relay
 *   sessions their `ssh_relay_open` commands established (§5.1);
 * - forward `blob` to the peer socket BLIND - the plane reads the ref and
 *   nothing else (§5.5; an unopened byte copy is the whole job);
 * - enforce SSH_RELAY_MAX_PER_NODE at session-open time (§5.3's loud refusal);
 * - tear down on every §5.6 cut (grace elapsed, child exit, lifetime expiry,
 *   A dropping, grant revoke) with the named-reason close and the
 *   `node.ssh_relay.close` audit.
 * The stub records what arrived per node so the wiring is testable today
 * without the broker being real, and so the day it lands, the tests that
 * assert "a routed frame reaches the seam" do not move.
 */

/** What the stub holds for one node until Task 8's broker replaces it. */
export interface RelayFrameStubRecord {
  /** How many relay frames have been routed from this node. */
  frames: number;
  /** The most recent frame, kept verbatim - blob included, still opaque. */
  last: RelayFrame;
}

const seenByNode = new Map<string, RelayFrameStubRecord>();

/**
 * Route one validated relay frame from `nodeId`. Today: record it. Task 8:
 * replace with the blind pair-and-forward of §5.1/§5.3/§5.5.
 * @param nodeId - the node whose authenticated socket produced the frame
 * @param frame - the grammar-validated frame (`parseRelayFrame` narrowed it)
 */
export function onRelayFrame(nodeId: string, frame: RelayFrame): void {
  const record = seenByNode.get(nodeId);
  if (record) {
    record.frames += 1;
    record.last = frame;
  } else {
    seenByNode.set(nodeId, { frames: 1, last: frame });
  }
  // TODO(Task 8): pair by `frame.ref` against the relay session this
  // pairing's ssh_relay_open established, forward the blob unopened to the
  // peer's socket, and close-with-named-reason on every §5.6 cut. A frame
  // with no brokered session behind it is refused there, with a reason.
}

/**
 * What the stub recorded for one node (the frame count and the last frame,
 * verbatim).
 * @internal test-only; Task 8's broker replaces this module's surface
 */
export function relayFramesSeenFor(nodeId: string): RelayFrameStubRecord | undefined {
  return seenByNode.get(nodeId);
}

/**
 * Drop every stub record.
 * @internal test-only; per-file isolation under `bun test --parallel`
 */
export function resetRelayFramesForTests(): void {
  seenByNode.clear();
}
