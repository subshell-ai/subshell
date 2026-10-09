import { buildAgentSocketPath } from "@internal/pane-runtime";
import {
  isSshGrantFingerprints,
  isSshKnownHostsPinLine,
  isSshPaneId,
  NODE_MAX_FRAME_BYTES,
  type NodeCommandBody,
  type RelayFrame,
  SSH_RELAY_CLOSE_REASONS,
  SSH_RELAY_LIFETIME_MS,
  SSH_RELAY_MAX_PER_NODE,
  SSH_RELAY_TEARDOWN_GRACE_MS,
  type SshNodeCommandBody,
  type SshRelayCloseReason,
  type SshRelayOpenCommand,
} from "@internal/subshell-protocol";
import type { NodeKind } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { binaryPayload, sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * The plane relay broker (spec 2026-10-08 §5.3, Task 8): the pairing machine
 * for the sealed agent relay. `openRelay` brokers a session between A (the
 * key home) and B (the connecting machine) - gate, quota, mint, audit, then
 * the two signed `ssh_relay_open` commands carrying the WHOLE pairing: both
 * node ids with roles, the peer's registered signing key (JSON public JWK)
 * and encryption key (base64 of the UTF-8 JSON public JWK - the one canonical
 * spelling, acceptance (h)), the grant's fingerprint set, the lifetime, and
 * the pane (acceptance (b)). From then on the plane's only job is §5.5:
 * route `relay` frames by their opaque ref, blob byte-for-byte unopened.
 *
 * **The blindness is the posture.** No session record holds a blob, a key,
 * a fingerprint, or a payload; `routeRelayFrame` copies the frame object it
 * was handed to the peer's socket and never reads `blob` (§5.5: an unopened
 * byte copy is the whole forwarding job). Durably, the plane writes only the
 * two audit rows - `node.ssh_relay.open` / `node.ssh_relay.close`, ids, hosts
 * and the named reason, never secrets (Global Constraints, docs/security.md
 * §10).
 *
 * **Teardown is by named reason only** (§5.1/§5.6). The grammar's six words
 * are the whole vocabulary, and every cut below maps to exactly one:
 * lifetime expiry, the handshake grace elapsed without both sides, A's link
 * dropping, a grant revoke, the pane's child exiting, and an over-cap frame.
 * Each cut sends the named-reason `ssh_relay_close` to BOTH sides and writes
 * the close audit. A B-side link loss deliberately names no new reason: the
 * grammar has no `b-dropped` word, §5.6 does not name B-dropping as a cut,
 * and the task-7 handoff is explicit that phantom state ends at Task 8's
 * timers - so an undeliverable reply to a gone B loses the ONE frame and the
 * session dies at its lifetime cap, child exit, or revoke, never at a
 * misnamed reason.
 *
 * **The per-node send glue throws on drop** (acceptance (c), mirroring the
 * T6/T7 deliver-or-throw contract at the endpoints): {@link
 * sendRelayFrameOverNodeSocket} refuses LOUDLY when the peer has no live
 * socket, its record is closing or superseded, its encrypted link is not
 * established, or the write itself fails. A silent-return pump reintroduces
 * the phantom-request hang, so a routed frame whose peer socket is dead
 * tears the session down (`a-dropped`) instead of leaving it spinning.
 *
 * **The machine answer about the socket is never trusted** (acceptance (e)):
 * B's open answers with the proxy socket path it bound, and the plane
 * re-derives the same path (`buildAgentSocketPath`, the shared pane-runtime
 * helper the node itself binds) from ITS record of B's dataDir and the
 * command's paneId, refusing a single-byte mismatch before the launch
 * exports anything. `SSH_AUTH_SOCK` then leaves through
 * {@link sshRelayPaneEnv} as the one-key scoped exception - the exact channel
 * `ssh-launch.service.ts`'s `composeSshLaunch` uses for the ssh invocation
 * env (`createSubshell`'s `extraPaneEnv` member) - never the whole-pane env.
 *
 * Both relay roles require a switched-on AGENT node (acceptance (d)): the
 * plane's own `ssh_enabled` row must read 1 (default off fails closed, and a
 * missing row refuses too) and `kind` must be `agent` - `local` is never an
 * A or B. Both checks run before any session exists, any command leaves, or
 * any audit row is written, as does the quota (acceptance (g)): a 9th live
 * session on either node is a loud `SshRelayRefusal("quota")` that touched
 * nothing.
 *
 * Everything outside the module is a {@link RelayBrokerDeps} seam (the
 * `getNodeWsDeps` pattern): the command transport, the per-node relay pump,
 * the node rows, the audit sink, and a clock/scheduler so the 30 s lifetime
 * and the 5 s grace are testable without waiting. The production wiring is
 * the default at the bottom of this file; the singleton is the seam
 * `nodes/relay-frames.ts` and the pane-death sweeps route through.
 */

/** The peer's registered relay keys, as the identities store holds them (public halves only). */
export interface RelayPeerKeys {
  /** The peer's ES256 signing public key: JSON-serialized public JWK (§4.2's reporting spelling). */
  signingPublicKey: string;
  /**
   * The peer's ECDH-ES encryption public key: JSON-serialized public JWK.
   * The signed command carries it as base64 of its UTF-8 bytes (acceptance
   * (h)); the pin stores the decoded string byte-equal.
   */
  encryptionPublicJwk: string;
}

/** Why an `openRelay` refused. Each code names its own door; the message says more. */
export type SshRelayRefusalCode =
  | "bad-pane-id"
  | "bad-fingerprints"
  | "bad-host-pin"
  | "same-node"
  | "no-node"
  | "local-node"
  | "node-off"
  | "no-datadir"
  | "quota"
  | "handshake"
  | "bad-socket-path";

/** The loud refusal {@link RelayBroker.openRelay} throws. No session exists after one. */
export class SshRelayRefusal extends Error {
  readonly code: SshRelayRefusalCode;
  /** The node the refusal is about, when it is node-shaped. */
  readonly nodeId: string | undefined;

  constructor(code: SshRelayRefusalCode, message: string, nodeId?: string) {
    super(message);
    this.name = "SshRelayRefusal";
    this.code = code;
    this.nodeId = nodeId;
  }
}

/**
 * The per-node relay pump's refusal (acceptance (c)): a frame that could not
 * be delivered. Thrown, never swallowed - the endpoint's deliver-or-throw
 * contract and the broker's teardown both depend on the raise.
 */
export class RelaySendError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, message: string) {
    super(`relay send to node "${nodeId}" refused: ${message}`);
    this.name = "RelaySendError";
    this.nodeId = nodeId;
  }
}

/** The observable view of one brokered session. Never carries a blob, key, or payload (§5.5). */
export interface RelaySessionInfo {
  relayId: string;
  ref: string;
  grantId: string;
  paneId: string;
  aNode: string;
  bNode: string;
  /** Epoch-ms expiry (lifetime cap, §5.6). */
  expiresAt: number;
  /** B's verified proxy socket path; null until B's open ack lands. */
  socketPath: string | null;
  aOpened: boolean;
  bOpened: boolean;
}

/** Inputs to {@link RelayBroker.openRelay}. A grant's id and selection are T10's; they arrive as inputs here. */
export interface OpenRelayInput {
  /** The live grant this session runs under (revoke cuts the session, §6.3). */
  grantId: string;
  /** The grant's selected fingerprints (§5.4); validated with the grammar's own predicate before signing. */
  fingerprints: readonly string[];
  /** The B-side pane the pairing serves (grammar (b)); pre-minted subshell id. */
  paneId: string;
  /** The key home's node id. */
  aNode: string;
  /** The connecting machine's node id. */
  bNode: string;
  /** A's registered public halves, from A's identity row. */
  aPeer: RelayPeerKeys;
  /** B's registered public halves, from B's identity row. */
  bPeer: RelayPeerKeys;
  /**
   * The destination's pinned `known_hosts` line (spec 2026-10-08 §9, Task
   * 12), REQUIRED and validated with the wire grammar's own predicate before
   * anything is signed. B's open writes it to the pane's 0600 pinned file;
   * a broker call without it is a broker bug, refused like the bad-pane-id
   * and bad-fingerprints doors beside it.
   */
  hostPin: string;
}

/** What a successful `openRelay` answers: the pairing, plus the socket the pane's scoped env must point at. */
export interface OpenRelayResult {
  relayId: string;
  /** The opaque routing ref - the plane's blind pairing key (the plan's `sessionRef`). */
  ref: string;
  /** ISO 8061 expiry: the lifetime cap (§5.6). */
  expiresAt: string;
  /** B's proxy socket, byte-verified against the shared derivation (acceptance (e)). */
  socketPath: string;
}

/** Opaque timer handle: the scheduler seam's own identity, carried untouched to `cancel`. */
export type TimerHandle = unknown;

/** The broker's world, every seam injectable (production default at the bottom). */
export interface RelayBrokerDeps {
  /** The signed command transport (`node-rpc.sendCommand`). */
  sendCommand(nodeId: string, cmd: NodeCommandBody, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** The per-node relay pump; MUST throw on any non-delivery (acceptance (c)). */
  sendRelayFrame(nodeId: string, frame: RelayFrame): void;
  /** The plane's own node row (kind + gate), or null when there is none. */
  nodeRow(nodeId: string): Promise<{ kind: NodeKind; sshEnabled: number | null } | null | undefined>;
  /** The node's dataDir from its live `ready` facts, or null (not fully connected). */
  nodeDataDir(nodeId: string): string | null;
  /** The audit sink (best-effort by contract, never throws). */
  audit(event: AuditEventInput): Promise<void>;
  nowMs(): number;
  /** Injected scheduler so the 30 s / 5 s windows drive without waiting. */
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
  log(line: string): void;
}

/** The broker surface: open, route, the named cuts, and the census views. */
export interface RelayBroker {
  /** Broker A+B for one pane under one grant; throws {@link SshRelayRefusal} loudly. */
  openRelay(input: OpenRelayInput): Promise<OpenRelayResult>;
  /** Route one grammar-parsed relay frame from `nodeId` BLIND to its peer (§5.5). */
  routeRelayFrame(nodeId: string, frame: RelayFrame): void;
  /** The single teardown entry: named reason to BOTH sides + the close audit. Idempotent. */
  closeRelay(ref: string, reason: SshRelayCloseReason): Promise<boolean>;
  /** Grant-revoke hook (§6.3; the revoke route lands in T10). Returns sessions closed. */
  closeForGrant(grantId: string, reason: SshRelayCloseReason): Promise<number>;
  /** Pane-death hook (the §5.6 child-exit cut; wired at the sweep sites). Returns sessions closed. */
  closeForPane(paneId: string, reason: SshRelayCloseReason): Promise<number>;
  /** §5.1's over-cap refusal: close the named ref with reason `over-cap`. */
  refuseOverCap(ref: string): Promise<boolean>;
  /** The `a-dropped` cut, witnessed by the node socket's death. Returns sessions closed. */
  onNodeSocketClosed(nodeId: string): Promise<number>;
  /** Live sessions touching this node in EITHER role (the quota's count). */
  activeRelayCount(nodeId: string): number;
  /** The observable view of one ref (test/diagnosis); null when nothing is brokered under it. */
  sessionInfo(ref: string): RelaySessionInfo | null;
  /** Drop everything (timer-cancelling; daemon-test isolation). */
  reset(): void;
}

/** One brokered pairing, in memory only (§5.3: durable life is the audit rows). */
interface Session {
  relayId: string;
  ref: string;
  grantId: string;
  paneId: string;
  aNode: string;
  bNode: string;
  expiresAt: number;
  socketPath: string | null;
  aOpened: boolean;
  bOpened: boolean;
  lifetimeTimer: TimerHandle;
  graceTimer: TimerHandle;
}

/**
 * Acceptance (h): base64 of the UTF-8 bytes of the JSON public JWK - the ONE
 * spelling the node decodes back into the byte-equal pin string. Exported for
 * the §4.5 re-pair service, which re-delivers the same pair in the same
 * carriage (ssh-machine-pins.service.ts); two carriers of one canonical
 * spelling must not be two implementations of it.
 */
export function base64OfJwk(jwkJson: string): string {
  return Buffer.from(jwkJson, "utf8").toString("base64");
}

function openCmd(input: OpenRelayInput, role: "A" | "B", ref: string, relayId: string): SshRelayOpenCommand {
  const peer = role === "A" ? input.bPeer : input.aPeer; // each side pins the PEER, never itself
  return {
    type: "ssh_relay_open",
    relayId,
    ref,
    role,
    aNodeId: input.aNode,
    bNodeId: input.bNode,
    peerSigningPublicKey: peer.signingPublicKey,
    peerEncryptPublicKey: base64OfJwk(peer.encryptionPublicJwk),
    grantId: input.grantId,
    fingerprints: [...input.fingerprints],
    lifetimeMs: SSH_RELAY_LIFETIME_MS,
    paneId: input.paneId,
    hostPin: input.hostPin,
  };
}

/** Build a broker over the given seams. The module singleton (bottom) is one of these with the real world. */
export function createRelayBroker(deps: RelayBrokerDeps): RelayBroker {
  /** The ONE map: opaque ref -> session (§5.3). A ref nothing brokered is refused, never guessed. */
  const byRef = new Map<string, Session>();

  const infoOf = (s: Session): RelaySessionInfo => ({
    relayId: s.relayId,
    ref: s.ref,
    grantId: s.grantId,
    paneId: s.paneId,
    aNode: s.aNode,
    bNode: s.bNode,
    expiresAt: s.expiresAt,
    socketPath: s.socketPath,
    aOpened: s.aOpened,
    bOpened: s.bOpened,
  });

  const closeSends = (s: Session, reason: SshRelayCloseReason): Promise<PromiseSettledResult<unknown>[]> => {
    // The named close to BOTH sides, best-effort on the transport (the audit
    // records the cut whatever the sockets do; a refused close delivery names
    // the side in the log and nothing more).
    const cmd: SshNodeCommandBody = { type: "ssh_relay_close", ref: s.ref, reason };
    return Promise.allSettled([
      Promise.resolve().then(() => deps.sendCommand(s.aNode, cmd)),
      Promise.resolve().then(() => deps.sendCommand(s.bNode, cmd)),
    ]);
  };

  const closeRelay = async (ref: string, reason: SshRelayCloseReason): Promise<boolean> => {
    const s = byRef.get(ref);
    if (!s) return false;
    // Grammar membership is a code-path guard, not paranoia theater: the
    // node's parser refuses an unnamed close, and §5.1's posture is that an
    // unnamed close is the silence this family refuses.
    if (!(SSH_RELAY_CLOSE_REASONS as readonly string[]).includes(reason)) {
      deps.log(`relay broker: close refused for ${ref}: reason "${reason}" is not a named reason`);
      return false;
    }
    // Remove FIRST, arm the cut's sends next: a concurrent route/drop must
    // never forward onto a session already being torn down.
    byRef.delete(ref);
    deps.cancel(s.lifetimeTimer);
    deps.cancel(s.graceTimer);
    await closeSends(s, reason);
    await deps.audit({
      actorUserId: null, // the plane brokered it; the human's act is the launch/grant audit
      action: "node.ssh_relay.close",
      targetType: "node",
      targetId: s.aNode,
      // ids, hosts, reason - never keys, fingerprints, sockets, or payloads
      // (Global Constraints; docs/security.md §10).
      metadataJson: JSON.stringify({
        relayId: s.relayId,
        ref: s.ref,
        grantId: s.grantId,
        paneId: s.paneId,
        aNodeId: s.aNode,
        bNodeId: s.bNode,
        reason,
      }),
    });
    return true;
  };

  const forEach = (match: (s: Session) => boolean): Session[] => [...byRef.values()].filter(match);

  const openRelay = async (input: OpenRelayInput): Promise<OpenRelayResult> => {
    // Validation FIRST: a malformed input is refused before a row is read, a
    // session exists, or a byte is audited.
    if (!isSshPaneId(input.paneId)) {
      throw new SshRelayRefusal("bad-pane-id", `relay open refused: paneId "${input.paneId}" is not a path id`);
    }
    if (!isSshGrantFingerprints(input.fingerprints)) {
      throw new SshRelayRefusal(
        "bad-fingerprints",
        "relay open refused: the grant's fingerprint set is malformed or over SSH_MAX_GRANT_FINGERPRINTS",
      );
    }
    // Task 12 (spec §9): the destination's pin travels on the open, and the
    // grammar's own line predicate is the broker's check too - a relay
    // session with no pin (or with a multi-line smuggle) is refused BEFORE
    // anything is signed or sent, so "the relay grant carries a pin" is
    // enforced at the mint, not hoped for at the endpoints.
    if (!isSshKnownHostsPinLine(input.hostPin)) {
      throw new SshRelayRefusal(
        "bad-host-pin",
        "relay open refused: the destination host pin is missing, empty, or not one known_hosts line",
      );
    }
    if (input.aNode === input.bNode) {
      // A relay bridges two machines; a one-machine pairing means a caller
      // that should not have asked at all.
      throw new SshRelayRefusal("same-node", "relay open refused: A and B name the same machine");
    }
    // (d) the gate: BOTH sides must be switched-on AGENT nodes, fail closed.
    // The plane's row is the authoritative half of the double gate (the node
    // re-checks its own mirror on delivery; both refusals are this posture).
    for (const nodeId of [input.aNode, input.bNode]) {
      const row = await deps.nodeRow(nodeId);
      if (!row) throw new SshRelayRefusal("no-node", `relay open refused: node "${nodeId}" has no row`, nodeId);
      if (row.kind !== "agent") {
        throw new SshRelayRefusal("local-node", `relay open refused: "${nodeId}" is not an agent machine`, nodeId);
      }
      if (row.sshEnabled !== 1) {
        throw new SshRelayRefusal("node-off", `relay open refused: SSH is not enabled on "${nodeId}"`, nodeId);
      }
    }
    // The socket-path byte-check needs B's dataDir; without `ready` facts the
    // plane cannot verify B's answer, so it refuses rather than trust it.
    const bDataDir = deps.nodeDataDir(input.bNode);
    if (bDataDir === null) {
      throw new SshRelayRefusal(
        "no-datadir",
        `relay open refused: "${input.bNode}" has not reported its data dir yet`,
        input.bNode,
      );
    }
    // (g) the quota, before ANY state: a 9th live session on either node is
    // a loud refusal that touched nothing - no audit, no command, no record.
    for (const nodeId of [input.aNode, input.bNode]) {
      const live = forEach((s) => s.aNode === nodeId || s.bNode === nodeId).length;
      if (live >= SSH_RELAY_MAX_PER_NODE) {
        throw new SshRelayRefusal(
          "quota",
          `relay open refused: node "${nodeId}" already holds ${live} live relay sessions (max ${SSH_RELAY_MAX_PER_NODE})`,
          nodeId,
        );
      }
    }

    const relayId = crypto.randomUUID();
    const ref = crypto.randomUUID(); // opaque pairing key; entropy is minted, never negotiated
    const expiresAt = deps.nowMs() + SSH_RELAY_LIFETIME_MS;
    const s: Session = {
      relayId,
      ref,
      grantId: input.grantId,
      paneId: input.paneId,
      aNode: input.aNode,
      bNode: input.bNode,
      expiresAt,
      socketPath: null,
      aOpened: false,
      bOpened: false,
      lifetimeTimer: deps.schedule(() => {
        void closeRelay(ref, "lifetime-expiry").catch((err: unknown) => deps.log(`relay close threw: ${String(err)}`));
      }, SSH_RELAY_LIFETIME_MS),
      graceTimer: deps.schedule(() => {
        if (s.aOpened && s.bOpened) return;
        void closeRelay(ref, "handshake-grace").catch((err: unknown) => deps.log(`relay close threw: ${String(err)}`));
      }, SSH_RELAY_TEARDOWN_GRACE_MS),
    };
    byRef.set(ref, s);
    await deps.audit({
      actorUserId: null,
      action: "node.ssh_relay.open",
      targetType: "node",
      targetId: input.aNode,
      metadataJson: JSON.stringify({
        relayId,
        ref,
        grantId: input.grantId,
        paneId: input.paneId,
        aNodeId: input.aNode,
        bNodeId: input.bNode,
        fingerprintCount: input.fingerprints.length, // the COUNT, never the set
        lifetimeMs: SSH_RELAY_LIFETIME_MS,
      }),
    });

    // Deliver the pairing. Both opens go out now; the acks complete the
    // handshake the grace timer watches. The open command's transport
    // deadline is the grace itself - past that window the session is already
    // cut, so waiting longer only delays the refusal the human reads.
    const expectedSocketPath = buildAgentSocketPath(bDataDir, input.paneId);
    const [resA, resB] = await Promise.allSettled([
      deps.sendCommand(input.aNode, openCmd(input, "A", ref, relayId), { timeoutMs: SSH_RELAY_TEARDOWN_GRACE_MS }),
      deps.sendCommand(input.bNode, openCmd(input, "B", ref, relayId), { timeoutMs: SSH_RELAY_TEARDOWN_GRACE_MS }),
    ]);
    if (resA.status === "fulfilled") s.aOpened = true;
    if (resB.status === "fulfilled") s.bOpened = true;

    if (resB.status === "fulfilled") {
      // (e): B answers the socket it bound. The plane re-derives the path and
      // refuses a byte mismatch - a machine answer never names the path the
      // pane's ssh gets pointed at.
      const ack = resB.value as { socketPath?: unknown };
      if (typeof ack?.socketPath !== "string" || ack.socketPath !== expectedSocketPath) {
        await closeRelay(ref, "handshake-grace");
        throw new SshRelayRefusal(
          "bad-socket-path",
          `relay open refused: "${input.bNode}" answered a socket path the plane did not derive`,
          input.bNode,
        );
      }
      s.socketPath = ack.socketPath;
    }

    if (!(s.aOpened && s.bOpened) || !byRef.has(ref)) {
      // Either side refused (pin moved, mirror off, offline, timeout) or the
      // grace already cut the pairing: the handshake never completed. Close
      // under the handshake word (idempotent if the grace already did) - the
      // grammar names no "refused-open", and §5.6's window cut is the honest
      // bucket for a pairing that did not come up on both ends.
      await closeRelay(ref, "handshake-grace");
      const why =
        resA.status === "rejected"
          ? `A refused or did not answer: ${String(resA.reason)}`
          : resB.status === "rejected"
            ? `B refused or did not answer: ${String(resB.reason)}`
            : "the handshake window closed before both sides answered";
      throw new SshRelayRefusal("handshake", `relay open refused: ${why}`);
    }

    // Both sides are live: the grace is no longer owed (the lifetime cap stays
    // as §5.6's ceiling).
    deps.cancel(s.graceTimer);
    return { relayId, ref, expiresAt: new Date(expiresAt).toISOString(), socketPath: s.socketPath as string };
  };

  const routeRelayFrame = (nodeId: string, frame: RelayFrame): void => {
    // §5.5 in one line's worth of reading: look up the ref, find the peer,
    // copy the frame. The blob never comes anywhere near this function's
    // comprehension - it is passed by reference and that IS the forwarding.
    const s = byRef.get(frame.ref);
    if (!s) {
      // A stale ref (the session was cut around the plane's own close) or a
      // stranger pointing at someone's pairing: refused, logged by ref, and
      // NOTHING else - refs are opaque ids, not secrets, and naming one is
      // how an operator correlates the two machines' logs.
      deps.log(`relay frame for unbrokered ref ${frame.ref}: refused`);
      return;
    }
    const fromA = s.aNode === nodeId;
    if (!fromA && s.bNode !== nodeId) {
      deps.log(`relay frame for ref ${frame.ref} from non-party ${nodeId}: refused`);
      return;
    }
    const peer = fromA ? s.bNode : s.aNode;
    try {
      deps.sendRelayFrame(peer, frame);
    } catch (err) {
      deps.log(`relay frame for ref ${frame.ref} could not reach ${peer}: ${String(err)}`);
      if (fromA) {
        // A's reply cannot reach B: the grammar has no b-dropped word, §5.6
        // does not list B's link as a cut, and T7's handoff is explicit that
        // the caps own the end of a B-side stall. Lose this frame; the
        // lifetime, child exit, or revoke cuts the session.
        return;
      }
      // B's request cannot reach A: THAT is §5.6's A-dropping (and the
      // phantom-request hang acceptance (c) exists to kill). Cut now with the
      // named reason; B is still reachable to hear it.
      void closeRelay(frame.ref, "a-dropped").catch((err2: unknown) => deps.log(`relay close threw: ${String(err2)}`));
    }
  };

  return {
    openRelay,
    routeRelayFrame,
    closeRelay,
    async closeForGrant(grantId, reason) {
      let n = 0;
      for (const s of forEach((x) => x.grantId === grantId)) if (await closeRelay(s.ref, reason)) n += 1;
      return n;
    },
    async closeForPane(paneId, reason) {
      let n = 0;
      for (const s of forEach((x) => x.paneId === paneId)) if (await closeRelay(s.ref, reason)) n += 1;
      return n;
    },
    refuseOverCap: (ref) => closeRelay(ref, "over-cap"),
    async onNodeSocketClosed(nodeId) {
      // ONLY the A-side cut (§5.6: "A-drop ... as earlier cuts"). B's link
      // may redial with its registry intact; B's real end is the child-exit
      // sweep or a cap, not this witness.
      let n = 0;
      for (const s of forEach((x) => x.aNode === nodeId)) if (await closeRelay(s.ref, "a-dropped")) n += 1;
      return n;
    },
    activeRelayCount(nodeId) {
      return forEach((s) => s.aNode === nodeId || s.bNode === nodeId).length;
    },
    sessionInfo(ref) {
      const s = byRef.get(ref);
      return s ? infoOf(s) : null;
    },
    reset() {
      for (const s of byRef.values()) {
        deps.cancel(s.lifetimeTimer);
        deps.cancel(s.graceTimer);
      }
      byRef.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* the real per-node pump (acceptance (c)): deliver, or THROW           */
/* ------------------------------------------------------------------ */

/**
 * Write one relay frame to `nodeId`'s CURRENT live socket, sealed through
 * its established link (a relay frame is never plaintext: the version gate
 * guarantees any node that carries one speaks protocol 18, whose sockets are
 * handshake-classified). Throws {@link RelaySendError} on every non-delivery:
 * no live connection, a closing/superseded record, an unestablished link, or
 * a failing write. The broker's teardown and the endpoints' deliver-or-throw
 * contract both read the throw; a silent return is the phantom-hang bug.
 */
export function sendRelayFrameOverNodeSocket(nodeId: string, frame: RelayFrame): void {
  const conn = getLive(nodeId);
  if (!conn) throw new RelaySendError(nodeId, "node has no live connection");
  if (conn.closing) throw new RelaySendError(nodeId, "connection is closing (superseded or revoked)");
  if (!conn.link) throw new RelaySendError(nodeId, "encrypted link is not established");
  const payload = JSON.stringify(frame);
  if (Buffer.byteLength(payload) > NODE_MAX_FRAME_BYTES) {
    throw new RelaySendError(nodeId, `frame exceeds ${NODE_MAX_FRAME_BYTES} bytes`);
  }
  try {
    conn.ws.send(binaryPayload(conn.link.sealFrame(payload)));
  } catch (err) {
    throw new RelaySendError(nodeId, `socket send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* the pane-scoped env (acceptance (e)) + the death sweeps             */
/* ------------------------------------------------------------------ */

/**
 * The pane env the relay launch exports: EXACTLY the scoped `SSH_AUTH_SOCK`
 * exception, the one key the `ssh` invocation gets through `createSubshell`'s
 * `extraPaneEnv` member - the same channel `composeSshLaunch` uses for the
 * snapshot's agent socket (spec 2026-10-07 §5.2, decision 3). Never merged
 * into the whole-pane env (Global Constraints: the agent-capable socket
 * belongs to the connecting process, not the pane's shell).
 */
export function sshRelayPaneEnv(socketPath: string): { SSH_AUTH_SOCK: string } {
  return { SSH_AUTH_SOCK: socketPath };
}

/**
 * The §5.6 child-exit cut for one pane, best-effort by shape (the
 * `sweepLocalSshDir` doctrine restated for relay sessions): every site where
 * a pane stops existing calls it, the broker's map lookup no-ops the
 * overwhelmingly common "this pane never relayed" case, and a failure costs
 * one log line. The reason is `child-exit` for every stop path: the pane's
 * process is gone, which is what the word means to the endpoints.
 */
export function closeRelayForPaneExit(paneId: string | null | undefined): void {
  if (!paneId) return;
  try {
    void getRelayBroker()
      .closeForPane(paneId, "child-exit")
      .catch((err: unknown) => logger.warn(`relay sweep for pane ${paneId} failed: ${String(err)}`));
  } catch (err) {
    logger.withError(err).warn(`relay sweep for pane ${paneId} threw`);
  }
}

/** Row-shaped twin of {@link closeRelayForPaneExit} for the sites that hold a row. */
export function sweepRelayForPane(row: { id: string } | null | undefined): void {
  closeRelayForPaneExit(row?.id);
}

/* ------------------------------------------------------------------ */
/* production wiring + module singleton                                */
/* ------------------------------------------------------------------ */

let defaultDeps: RelayBrokerDeps | undefined;

function productionDeps(): RelayBrokerDeps {
  defaultDeps ??= {
    sendCommand: (nodeId, cmd, opts) => sendCommand(nodeId, cmd, opts ?? {}),
    sendRelayFrame: sendRelayFrameOverNodeSocket,
    async nodeRow(nodeId) {
      const row = await getRequestlessContext().repos.nodes.findById(nodeId);
      return row ? { kind: row.kind, sshEnabled: row.sshEnabled } : null;
    },
    nodeDataDir: (nodeId) => getLive(nodeId)?.agent?.dataDir ?? null,
    audit,
    nowMs: () => Date.now(),
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.(); // a brokered relay must never hold the process (or a test runner) open
      return t as unknown as TimerHandle;
    },
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (line) => logger.debug(line),
  };
  return defaultDeps;
}

let singleton: RelayBroker | undefined;

/** The broker the handler routing and the pane-death sweeps use (lazy, like `getNodeWsDeps`). */
export function getRelayBroker(): RelayBroker {
  singleton ??= createRelayBroker(productionDeps());
  return singleton;
}

/**
 * Install (or with null, drop) the module singleton.
 * @internal test-only - relay-frames routing and the sweep helpers reach the
 * broker through it, and a suite with injected seams must be able to point
 * those two entry points at a recorder.
 */
export function setRelayBrokerForTests(broker: RelayBroker | null): void {
  singleton = broker ?? undefined;
}
