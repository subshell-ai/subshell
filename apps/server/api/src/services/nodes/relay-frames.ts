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
 * A second entry point, {@link onRelayFrameOverCap}, carries the refusal
 * this grammar performs but cannot express in a `NodeEvent` (an over-cap
 * blob) so §5.1's named-reason close has something to be ABOUT.
 *
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

/** What the over-cap stub holds for one node until Task 8 replaces it. */
export interface RelayOverCapStubRecord {
  /** How many over-cap relay frames have been refused from this node. */
  overCaps: number;
  /** The routing ref of the most recent refusal. NEVER the blob: an over-cap frame is refused unread (§5.1, §5.5). */
  lastRef: string;
}

const seenByNode = new Map<string, RelayFrameStubRecord>();
const overCapByNode = new Map<string, RelayOverCapStubRecord>();

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
 * Refuse an over-cap relay frame BY NAME (spec 2026-10-08 §5.1). This is the
 * observability half of the refusal the strict grammar already performed:
 * `parseRelayFrame` answers an over-cap blob with null (so the `NodeEvent`
 * union stays safe) and `node-ws-handler.ts` probes the shape with
 * `relayFrameRefIfOverCap` and routes the named case here instead of the
 * silent "unrecognized" drop. The blob never comes along - the probe reads
 * its raw length and nothing else (§5.5).
 * @param nodeId - the node whose authenticated socket produced the frame
 * @param ref - the routing ref the well-formed candidate carried
 */
export function onRelayFrameOverCap(nodeId: string, ref: string): void {
  const record = overCapByNode.get(nodeId);
  if (record) {
    record.overCaps += 1;
    record.lastRef = ref;
  } else {
    overCapByNode.set(nodeId, { overCaps: 1, lastRef: ref });
  }
  // TODO(Task 8): this is where §5.1's named-reason close lands: look the
  // session up by `ref`, cut BOTH ends with ssh_relay_close reason
  // "over-cap" (SSH_RELAY_CLOSE_REASONS), and audit `node.ssh_relay.close`.
  // Until the broker exists, the record only proves the refusal is visible.
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
 * What the over-cap stub recorded for one node (the refusal count and the
 * last refused ref; never a blob).
 * @internal test-only; Task 8's broker replaces this module's surface
 */
export function relayOverCapsSeenFor(nodeId: string): RelayOverCapStubRecord | undefined {
  return overCapByNode.get(nodeId);
}

/**
 * Drop every stub record (routed frames and over-cap refusals alike).
 * @internal test-only; per-file isolation under `bun test --parallel`
 */
export function resetRelayFramesForTests(): void {
  seenByNode.clear();
  overCapByNode.clear();
}
