import type { RelayFrame } from "@internal/subshell-protocol";
import { getRelayBroker } from "@/services/ssh-relay.service.js";
import { logger } from "@/utils/logger.js";

/**
 * The plane-side recognition seam for `relay` link frames (spec 2026-10-08
 * §5.1/§5.3) - the single named point between "a decrypted, grammar-validated
 * relay frame arrived on an authenticated node socket" and the broker that
 * pairs the sockets. `node-ws-handler.ts` routes here from its event switch
 * and from its close teardown; nothing else calls in.
 *
 * What was ALREADY decided before a frame reaches this file, and is not
 * re-decided here: the socket is authenticated (the upgrade chain), the link
 * is encrypted and version-matched at NODE_PROTOCOL_VERSION (the handshake -
 * which is why a pre-18 agent never gets a relay frame routed at all), the
 * frame is well-formed and within SSH_RELAY_FRAME_MAX_BYTES (`parseRelayFrame`,
 * via `parseNodeEvent`), the node is not held, and the socket is not
 * superseded (all guards run upstream in the handler).
 *
 * The Task-8 broker (`services/ssh-relay.service.ts`) owns everything past
 * this door: it pairs the two live sockets by the frame's routing `ref`,
 * forwards `blob` to the peer BLIND (the plane reads the ref and nothing
 * else, §5.5), enforces the quota at open, and cuts on every §5.6 event with
 * the named-reason close and the `node.ssh_relay.close` audit. This module
 * adds only the per-node routing SUMMARY - frame count, last ref, last
 * direction - so the handler's wiring tests can see that a routed frame
 * reached the broker without this seam itself holding a byte of any blob
 * (§5.5: the summary's record deliberately has no blob slot).
 *
 * {@link onRelayFrameOverCap} is the second entry point: the refusal the
 * grammar performed (an over-cap blob answers `parseRelayFrame` with null)
 * but cannot express in a `NodeEvent`; the handler's shape probe routes the
 * named case here and the broker closes the session it names with reason
 * `over-cap`. The blob never comes along - the probe reads its raw length
 * and nothing else.
 *
 * {@link onNodeSocketClosed} is the third: when an authenticated live socket
 * dies, the broker cuts the sessions where that node was A (§5.6's
 * `a-dropped`); a node's B-side link redialing is not a cut, so the broker
 * decides by role itself and this seam just reports the witness.
 *
 * Routing is FIRE-AND-FORGET by contract: the handler's frame chain must not
 * die because a broker send refused - the broker already handled the drop
 * (its teardown IS the response to a refused send), and a throw here would
 * cost the socket every frame behind this one.
 */

/** What the seam records for one node's routed frames: counters and routing ids, never payloads. */
export interface RelayFrameRouteRecord {
  /** How many relay frames have been routed from this node. */
  frames: number;
  /** The routing ref of the most recent routed frame (an opaque id, not a secret). */
  lastRef: string;
  /** The direction of the most recent routed frame. */
  lastDirection: RelayFrame["direction"];
}

/** What the seam holds for one node's over-cap refusals. */
export interface RelayOverCapRecord {
  /** How many over-cap relay frames have been refused from this node. */
  overCaps: number;
  /** The routing ref of the most recent refusal. NEVER the blob: an over-cap frame is refused unread (§5.1, §5.5). */
  lastRef: string;
}

const routedByNode = new Map<string, RelayFrameRouteRecord>();
const overCapByNode = new Map<string, RelayOverCapRecord>();

/**
 * Route one validated relay frame from `nodeId` to the broker. Records the
 * per-node routing summary first (the handler tests' observability), then
 * hands the frame object to the broker unchanged.
 * @param nodeId - the node whose authenticated socket produced the frame
 * @param frame - the grammar-validated frame (`parseRelayFrame` narrowed it)
 */
export function onRelayFrame(nodeId: string, frame: RelayFrame): void {
  const record = routedByNode.get(nodeId);
  if (record) {
    record.frames += 1;
    record.lastRef = frame.ref;
    record.lastDirection = frame.direction;
  } else {
    routedByNode.set(nodeId, { frames: 1, lastRef: frame.ref, lastDirection: frame.direction });
  }
  try {
    // Blind hand-off: the broker pairs by `ref` and copies `blob` to the
    // peer's socket unopened (§5.5). A refused send (peer socket gone) is
    // the broker's named cut to perform, not an exception to propagate.
    getRelayBroker().routeRelayFrame(nodeId, frame);
  } catch (err: unknown) {
    logger.withError(err).warn(`relay routing for node ${nodeId} threw (contained): ${String(err)}`);
  }
}

/**
 * Refuse an over-cap relay frame BY NAME (spec 2026-10-08 §5.1): the broker
 * closes the session named by `ref` with reason `over-cap`, to both sides,
 * audited. An unbrokered ref has no session to close and costs a log line.
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
  void getRelayBroker()
    .refuseOverCap(ref)
    .catch((err: unknown) => logger.withError(err).warn(`relay over-cap close for ${ref} threw: ${String(err)}`));
}

/**
 * An authenticated LIVE node socket died. Tell the broker: sessions where
 * this node was A are cut with `a-dropped` (§5.6); its B-side sessions are
 * deliberately not (a B link that redials keeps its registry, and B's real
 * end is child-exit or a cap). A superseded socket's close never calls this
 * (the handler's per-connection identity owns the distinction) - the newer
 * socket's node is not gone.
 * @param nodeId - the node whose live connection just went away
 */
export function onNodeSocketClosed(nodeId: string): void {
  void getRelayBroker()
    .onNodeSocketClosed(nodeId)
    .catch((err: unknown) => logger.withError(err).warn(`relay socket-drop cut for ${nodeId} threw: ${String(err)}`));
}

/**
 * What the seam recorded for one node (the routed-frame summary: count, last
 * ref, last direction - never a blob).
 * @internal test-only: the handler's routing tests
 */
export function relayFramesSeenFor(nodeId: string): RelayFrameRouteRecord | undefined {
  return routedByNode.get(nodeId);
}

/**
 * What the seam recorded for one node's over-cap refusals (count and last
 * ref; never a blob).
 * @internal test-only
 */
export function relayOverCapsSeenFor(nodeId: string): RelayOverCapRecord | undefined {
  return overCapByNode.get(nodeId);
}

/**
 * Drop every seam record (routed summaries and over-cap refusals alike).
 * @internal test-only; per-file isolation under `bun test --parallel`
 */
export function resetRelayFramesForTests(): void {
  routedByNode.clear();
  overCapByNode.clear();
}
