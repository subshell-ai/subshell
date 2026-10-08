import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as mcpOpen, seal as mcpSeal } from "@internal/mcp-core";
import {
  base64UrlNoPad,
  type NodeCommandBody,
  openRelayEnvelope,
  type RelayEnvelopeOpen,
  type RelayFrame,
  sealRelayEnvelope,
  verifyRelayEnvelope,
} from "@internal/subshell-protocol";
import type { AuditEventInput } from "@/services/audit.js";
import {
  createRelayBroker,
  type OpenRelayResult,
  type RelayBroker,
  type TimerHandle,
} from "@/services/ssh-relay.service.js";
import {
  openARelaySession,
  openBRelaySession,
  RelaySessions,
} from "../../../../../../node/agent/src/commands/ssh-relay.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../../../../../node/agent/src/identity.js";
import {
  type AgentScheme,
  fingerprintAgentBlob,
  OPENSSH_10X_SCHEME,
} from "../../../../../../node/agent/src/relay-agent-scheme.js";

/**
 * The whole-stack fixture for `ssh-relay.integration.test.ts` (spec 2026-10-08
 * M2 Task 9): two in-process machine identities (real `loadOrCreateIdentity`
 * keypairs in real temp data dirs), a REAL B-side agent proxy, a REAL A-side
 * responder fed by a scheme-behavior stub agent, and the REAL plane broker
 * (`createRelayBroker`) wired to both through fake transport seams.
 *
 * **The fake plane is blind by construction.** It is given no private key of
 * any machine, no opener, and no codec call: the node-to-plane and
 * plane-to-node seams serialize the frame to JSON text and re-parse it (the
 * socket is what a plane actually holds), and the broker forwards `blob` by
 * reference without reading it. Everything the plane can see is enumerated on
 * `Stack.planeVisible()`: wire capture lines, audit rows, session views, and
 * its own log lines.
 *
 * The agent-byte builders and the stub agent below are the T6/T7 fixture
 * spellings (measured OpenSSH_10.2p1 behavior, hand-spelled byte literals),
 * reused rather than re-invented; the scheme constants come from the agent's
 * own `relay-agent-scheme.ts`.
 */

/* ------------------------------------------------------------------ */
/* the agent wire, spelled by hand (T7 fixture posture)                */
/* ------------------------------------------------------------------ */

/** The roster's granted key: its blob embeds the ASCII marker "KEY-IN". */
export const KEY_IN = Buffer.concat([
  Buffer.from([0, 0, 0, 7]),
  Buffer.from("ssh-ed25519"),
  sshStr(Buffer.from("KEY-IN")),
]);
/** The roster's ungranted key: the scope-before-forward witness blob. */
export const KEY_OUT = Buffer.concat([
  Buffer.from([0, 0, 0, 7]),
  Buffer.from("ssh-ed25519"),
  sshStr(Buffer.from("KEY-OUT")),
]);

/** One roster entry as the stub agent carries it. */
export interface RosterEntry {
  blob: Buffer;
  comment: string;
}

/** The stub's default roster: one granted key, one ungranted key. */
export const ROSTER: RosterEntry[] = [
  { blob: KEY_IN, comment: "granted key" },
  { blob: KEY_OUT, comment: "ungranted key" },
];

/** An independent fingerprint oracle: SHA-256 over the wire blob, base64url. */
export function fp(wire: Uint8Array): string {
  return fingerprintAgentBlob(wire);
}

/** 4-byte big-endian length. */
export function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** An SSH string on the agent wire: 4-byte BE length + bytes. */
export function sshStr(bytes: Buffer | string): Buffer {
  const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.concat([be32(b.length), b]);
}

/** A framed agent message: 4-byte BE length + payload (the ssh-agent wire). */
export function framed(payload: Buffer): Buffer {
  return Buffer.concat([be32(payload.length), payload]);
}

/** An IDENTITIES_ANSWER in the stub's scheme. */
export function buildIdentitiesAnswer(scheme: AgentScheme, entries: RosterEntry[]): Buffer {
  return Buffer.concat([
    Buffer.from([scheme.answer]),
    be32(entries.length),
    ...entries.flatMap((e) => [sshStr(e.blob), sshStr(e.comment)]),
  ]);
}

/** A classic-scheme SIGN_REQUEST (15): blob, data, flags. */
export function buildSignRequestClassic(keyBlob: Buffer, data = Buffer.from("DATA"), flags = 0): Buffer {
  return Buffer.concat([Buffer.from([15]), sshStr(keyBlob), sshStr(data), be32(flags)]);
}

/** A 10.x-scheme SIGN_REQUEST (13): blob, data, flags, optional algorithms. */
export function buildSignRequestTenX(
  keyBlob: Buffer,
  opts: { data?: Buffer; flags?: number; algorithms?: string } = {},
): Buffer {
  const parts = [Buffer.from([13]), sshStr(keyBlob), sshStr(opts.data ?? Buffer.from("DATA")), be32(opts.flags ?? 0)];
  if (opts.algorithms !== undefined) parts.push(sshStr(opts.algorithms));
  return Buffer.concat(parts);
}

/** Decode an IDENTITIES_ANSWER independently of the production parser. */
export function parseAnswer(answer: Buffer): { type: number; count: number; comments: string[] } {
  const type = answer[0];
  const count = answer.readUInt32BE(1);
  const comments: string[] = [];
  let off = 5;
  for (let i = 0; i < count; i += 1) {
    const blobLen = answer.readUInt32BE(off);
    off += 4 + blobLen;
    const cLen = answer.readUInt32BE(off);
    comments.push(answer.subarray(off + 4, off + 4 + cLen).toString("utf8"));
    off += 4 + cLen;
  }
  return { type, count, comments };
}

/* ------------------------------------------------------------------ */
/* the stub live agent (T7 fixture, 10.x by default)                   */
/* ------------------------------------------------------------------ */

/** A scheme-behavior stub agent socket: identities answers, well-formed signs answer SIGN_RESPONSE("SIG"). */
export interface StubAgent {
  path: string;
  /** Every request payload the stub received, in order (the open-time probes included). */
  received: Buffer[];
  close(): Promise<void>;
}

/**
 * Start the scheme-behavior stub agent on its own socket. Exported for the
 * roster-command case (Task 11): the `ssh_agent_identities` read needs A's
 * live agent and NOTHING ELSE - no broker, no grant, no pairing - so it
 * drives the stub without the full stack.
 */
export async function startStubAgent(roster: RosterEntry[], scheme: AgentScheme): Promise<StubAgent> {
  const dir = mkdtempSync(join(tmpdir(), "subshell-relay-stack-stub-"));
  const path = join(dir, "agent.sock");
  const received: Buffer[] = [];
  const server: Server = createServer((conn: Socket) => {
    let buffer = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) return;
        const request = Buffer.from(buffer.subarray(4, 4 + len));
        buffer = buffer.subarray(4 + len);
        received.push(request);
        const type = request[0];
        if (request.length === 1 && type === scheme.identities) {
          conn.write(framed(buildIdentitiesAnswer(scheme, roster)));
        } else if (type === scheme.sign && isWellFormedSignBody(request, scheme)) {
          conn.write(framed(Buffer.concat([Buffer.from([scheme.signResponse]), sshStr(Buffer.from("SIG"))])));
        } else {
          conn.write(framed(Buffer.from([5])));
        }
      }
    });
    conn.on("error", () => {
      /* the responder closes per request; the stub never throws */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(path);
  });
  return { path, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The stub's own sign-body validity check (mirrors the real agent's parser). */
function isWellFormedSignBody(p: Buffer, scheme: AgentScheme): boolean {
  let off = 1;
  const str = (): boolean => {
    if (off + 4 > p.length) return false;
    const n = p.readUInt32BE(off);
    off += 4;
    if (off + n > p.length) return false;
    off += n;
    return true;
  };
  if (!str()) return false; // blob
  if (off <= 5) return false; // empty blob length means an empty string: refuse
  if (!str()) return false; // data
  if (off + 4 > p.length) return false; // flags
  off += 4;
  if (off === p.length) return true;
  if (!scheme.extendedSign) return false;
  if (!str()) return false; // algorithms
  return off === p.length;
}

/* ------------------------------------------------------------------ */
/* the stack: broker + A machine + B machine over blind transport      */
/* ------------------------------------------------------------------ */

/** The pane the brokered pairing serves: a path-id spelling both grammars accept. */
export const PANE_ID = "11111111-2222-4333-8444-555555555555";

/** One recorded crossing of the plane: the JSON text and the node it landed on. */
export interface WireEntry {
  /** True for plane-to-node deliveries (the fake link's outbound half). */
  outbound: boolean;
  /** The node this text reached (or left). */
  nodeId: "a-node" | "b-node";
  /** The JSON text exactly as the fake socket carried it. */
  raw: string;
}

/** What {@link openStack} builds: the live stack plus everything it observed. */
export interface Stack {
  broker: RelayBroker;
  /** The broker's successful open result (ref, relayId, verified socketPath). */
  result: OpenRelayResult;
  /** The A machine's real identity (registered public halves live here). */
  aId: NodeIdentity;
  /** The B machine's real identity. */
  bId: NodeIdentity;
  /** The A machine's data dir (its identity and pin store live here). */
  aDir: string;
  /** The B machine's data dir (the proxy socket was bound under here). */
  bDir: string;
  /** The A-side node registry (responder under the brokered ref). */
  aRelay: RelaySessions;
  /** The B-side node registry (agent proxy under the brokered ref). */
  bRelay: RelaySessions;
  /** The stub agent A forwards granted requests to. */
  stub: StubAgent;
  /** Requests the stub received AFTER the open-time probe. */
  forwarded(): Buffer[];
  /** Every JSON text that crossed the plane, both directions, in order. */
  wire: WireEntry[];
  /** Audit rows the broker wrote, metadata re-serialized from the JSON string. */
  audits: { action: string; metadata: Record<string, unknown>; metadataJson: string }[];
  /** Broker log lines (plane-visible text). */
  brokerLines: string[];
  /** Commands the broker sent (plane-side composites; the open grammar's own view). */
  commands: { nodeId: string; cmd: NodeCommandBody }[];
  /**
   * Plane-visible text for the byte-opacity scan: wire captures, audit rows,
   * session views, broker log lines. Never the machines' innards.
   */
  planeVisible(): string[];
  /**
   * Simulated plane outage: while true, inbound B2A frames are captured but
   * not routed (A answers nothing until `releaseB2A` runs).
   */
  swallowB2A: boolean;
  /** Route every swallowed B2A frame now (A's late answers flow). */
  releaseB2A(): void;
  /** Deliver one frame INTO the plane as if `nodeId`'s socket carried it. */
  routeFromNode(nodeId: "a-node" | "b-node", frame: RelayFrame): void;
  /**
   * Run the named close on BOTH node registries WITHOUT the broker's own
   * teardown: the machines end the session while the plane's blind lane for
   * the ref stays up (still routing anything that re-presents it). The
   * ref-reuse replay case drives exactly this resurrection.
   */
  closeNodeSessions(ref: string, reason: string): void;
  /** Tear everything down (registries, stub socket, broker timers). */
  cleanup(): Promise<void>;
}

/** Options for {@link openStack}. */
export interface StackOptions {
  /** The grant's fingerprint set (default: the one granted key). */
  fingerprints?: readonly string[];
  /** The stub's roster (default: {@link ROSTER}). */
  roster?: RosterEntry[];
  /** The numbering the stub agent speaks (default: the fleet's measured 10.x). */
  scheme?: AgentScheme;
}

/**
 * Open the whole stack: real broker, real node branches, real identities, a
 * stub agent, and the blind fake plane. Resolves after the handshake
 * completed (both opens acked, B's socket path byte-verified by the broker
 * itself, so a returned stack means the plane's acceptance (e) check passed
 * against the proxy's real bound path).
 */
export async function openStack(opts: StackOptions = {}): Promise<Stack> {
  const scheme = opts.scheme ?? OPENSSH_10X_SCHEME;
  const fingerprints = opts.fingerprints ?? [fp(KEY_IN)];
  const aDir = mkdtempSync(join(tmpdir(), "subshell-relay-stack-a-"));
  const bDir = mkdtempSync(join(tmpdir(), "subshell-relay-stack-b-"));
  // The machines' REAL identities: signing + encryption keypairs as identity.ts
  // generates and stores them; the broker pairs their registered public halves.
  const aId = await loadOrCreateIdentity(aDir);
  const bId = await loadOrCreateIdentity(bDir);
  const stub = await startStubAgent(opts.roster ?? ROSTER, scheme);

  const aRelay = new RelaySessions();
  const bRelay = new RelaySessions();
  const wire: WireEntry[] = [];
  const audits: Stack["audits"] = [];
  const brokerLines: string[] = [];
  const commands: { nodeId: string; cmd: NodeCommandBody }[] = [];
  let swallowedB2A: RelayFrame[] = [];
  // The outage flag lives in a plain closure variable, NOT on `stack`:
  // routeFromNode already serves the open handshake (sendCommand's
  // sendRelayFrame seam) while `const stack` is still in its TDZ, and a
  // handshake-time B2A reading `stack.swallowB2A` would have thrown a
  // ReferenceError. The open's frame silence is protocol behavior the
  // fixture must not lean on to stay evaluable.
  let swallowArmed = false;

  /** Plane-to-node: serialize like a socket would, re-parse, hand to the node. */
  const deliverToNode = (nodeId: "a-node" | "b-node", frame: RelayFrame): void => {
    const raw = JSON.stringify(frame);
    wire.push({ outbound: true, nodeId, raw });
    const parsed = JSON.parse(raw) as RelayFrame;
    (nodeId === "a-node" ? aRelay : bRelay).onInboundRelayFrame(parsed);
  };

  /** Node-to-plane: the handler seam; the outage swallows B2A while armed. */
  const routeFromNode = (nodeId: "a-node" | "b-node", frame: RelayFrame): void => {
    const raw = JSON.stringify(frame);
    wire.push({ outbound: false, nodeId, raw });
    if (nodeId === "b-node" && frame.direction === "B2A" && swallowArmed) {
      swallowedB2A.push(JSON.parse(raw) as RelayFrame);
      return;
    }
    broker.routeRelayFrame(nodeId, frame);
  };

  const sendCommand = async (nodeId: string, cmd: NodeCommandBody): Promise<unknown> => {
    commands.push({ nodeId, cmd });
    if (cmd.type === "ssh_relay_open") {
      if (cmd.role === "A") {
        await openARelaySession({
          relay: aRelay,
          dataDir: aDir,
          selfNodeId: "a-node",
          cmd,
          sendRelayFrame: (f) => routeFromNode("a-node", f),
          resolveAgentSocket: () => stub.path,
        });
        return { relayId: cmd.relayId };
      }
      const { socketPath } = await openBRelaySession({
        relay: bRelay,
        dataDir: bDir,
        selfNodeId: "b-node",
        paneId: cmd.paneId,
        cmd,
        sendRelayFrame: (f) => routeFromNode("b-node", f),
      });
      return { socketPath };
    }
    if (cmd.type === "ssh_relay_close") {
      (nodeId === "a-node" ? aRelay : bRelay).close(cmd.ref, cmd.reason);
      return { ok: true };
    }
    throw new Error(`fake node ${nodeId}: unexpected command ${String(cmd.type)}`);
  };

  const broker = createRelayBroker({
    sendCommand,
    sendRelayFrame: deliverToNode,
    async nodeRow(nodeId) {
      return nodeId === "a-node" || nodeId === "b-node" ? { kind: "agent", sshEnabled: 1 } : null;
    },
    nodeDataDir: (nodeId) => (nodeId === "b-node" ? bDir : null),
    async audit(e: AuditEventInput) {
      audits.push({
        action: e.action,
        metadata: JSON.parse(e.metadataJson ?? "{}") as Record<string, unknown>,
        metadataJson: e.metadataJson ?? "",
      });
    },
    nowMs: () => 1_730_000_000_000, // fixed clock: no timer in the matrix should ever fire
    schedule: (): TimerHandle => {
      const handle: { fn?: () => void } = {};
      return handle; // never fired; cancel is a no-op
    },
    cancel: () => {},
    log: (line) => brokerLines.push(line),
  });

  const result = await broker.openRelay({
    grantId: "grant-1",
    fingerprints,
    paneId: PANE_ID,
    aNode: "a-node",
    bNode: "b-node",
    aPeer: { signingPublicKey: aId.signingPublicJwk, encryptionPublicJwk: aId.publicJwk },
    bPeer: { signingPublicKey: bId.signingPublicJwk, encryptionPublicJwk: bId.publicJwk },
  });

  const probeCount = stub.received.length; // whatever the open-time numbering probe asked

  const stack: Stack = {
    broker,
    result,
    aId,
    bId,
    aDir,
    bDir,
    aRelay,
    bRelay,
    stub,
    forwarded: () => stub.received.slice(probeCount),
    wire,
    audits,
    brokerLines,
    commands,
    planeVisible: () => [
      ...wire.map((w) => w.raw),
      ...audits.map((a) => a.metadataJson),
      ...brokerLines,
      JSON.stringify(broker.sessionInfo(result.ref)),
    ],
    // Accessor over the closure flag (see swallowArmed above): the property
    // stays a plain boolean on the Stack interface while routeFromNode reads
    // only the closure, never the not-yet-initialized stack.
    get swallowB2A() {
      return swallowArmed;
    },
    set swallowB2A(value: boolean) {
      swallowArmed = value;
    },
    releaseB2A() {
      const pending = swallowedB2A;
      swallowedB2A = [];
      for (const f of pending) broker.routeRelayFrame("b-node", f);
    },
    routeFromNode,
    closeNodeSessions(ref, reason) {
      // Closes ONLY the node-registry handlers for the ref (owned close, so
      // no tombstone). The broker's own session for the ref is left intact:
      // the plane routes by ref and knows nothing of relay ids, so a ref
      // re-presented by restarted endpoints is a plane-level event the
      // broker must keep routing while the ENDPOINTS refuse the old bytes.
      aRelay.close(ref, reason);
      bRelay.close(ref, reason);
    },
    async cleanup() {
      bRelay.closeAll("child-exit");
      aRelay.closeAll("child-exit");
      broker.reset();
      await stub.close();
    },
  };
  return stack;
}

/* ------------------------------------------------------------------ */
/* wire-side decoders: open + verify one captured frame the peer way   */
/* ------------------------------------------------------------------ */

/** What {@link decodeB2A}/{@link decodeA2B} return: the plaintext agent bytes + the bindings. */
export interface DecodedFrame {
  agentBytes: Buffer;
  seq: number;
  /** B's endpoint nonce: carried by every B2A AND echoed in every A2B (§5.6). */
  nB: string;
  /** A's endpoint nonce: absent only from the session's first request. */
  nA?: string;
}

/**
 * OPEN a B2A frame at A WITHOUT verifying anything (the confidentiality half
 * only): resolves iff the envelope is sealed to A's real encryption key and
 * its wrapper agrees with the frame. This is the openability witness the
 * refusal cases need: a downstream refusal (verification, the endpoint's gate)
 * is then provably a judgment about origin or replay, not a decryption failure
 * of a fixture-mis-sealed envelope - that one rejects HERE instead.
 */
export async function openB2A(s: Stack, frame: RelayFrame): Promise<RelayEnvelopeOpen> {
  return openRelayEnvelope({
    blob: frame.blob,
    own: { principalId: "node:a-node", publicJwk: s.aId.publicJwk, privateJwk: s.aId.privateJwk },
    open: mcpOpen,
    expect: { ref: frame.ref, direction: frame.direction },
  });
}

/**
 * Open + verify a B2A frame AS A did: B's signing key is the pinned origin,
 * A's real encryption private half opens the envelope. Throws exactly where
 * A's responder threw. The seq gate is the responder's own check, deliberately
 * absent here: an honestly-sealed low-seq envelope DECODES fine, which is what
 * makes the responder's refusal nameable as the gate's.
 */
export async function decodeB2A(s: Stack, frame: RelayFrame): Promise<DecodedFrame> {
  const opened = await openB2A(s, frame);
  const message = await verifyRelayEnvelope({
    jws: opened.jws,
    publicJwk: JSON.parse(s.bId.signingPublicJwk) as JsonWebKey,
    expect: { routingRef: frame.ref, direction: "B2A", seq: opened.seq, relaySessionId: s.result.relayId },
  });
  return {
    agentBytes: Buffer.from(message.agentBytesB64, "base64url"),
    seq: opened.seq,
    nB: message.nB ?? "",
    ...(message.nA === undefined ? {} : { nA: message.nA }),
  };
}

/**
 * Open + verify an A2B frame AS B did: A's signing key is the pinned origin,
 * B's real encryption private half opens the envelope. The witness for the
 * matrix's "B can open it with A's pinned encryption key" assertions.
 */
export async function decodeA2B(s: Stack, frame: RelayFrame): Promise<DecodedFrame> {
  const opened = await openRelayEnvelope({
    blob: frame.blob,
    own: { principalId: "node:b-node", publicJwk: s.bId.publicJwk, privateJwk: s.bId.privateJwk },
    open: mcpOpen,
    expect: { ref: frame.ref, direction: frame.direction },
  });
  const message = await verifyRelayEnvelope({
    jws: opened.jws,
    publicJwk: JSON.parse(s.aId.signingPublicJwk) as JsonWebKey,
    expect: { routingRef: frame.ref, direction: "A2B", seq: opened.seq, relaySessionId: s.result.relayId },
  });
  return {
    agentBytes: Buffer.from(message.agentBytesB64, "base64url"),
    seq: opened.seq,
    nB: message.nB ?? "",
    ...(message.nA === undefined ? {} : { nA: message.nA }),
  };
}

/** Seal one B2A request with the given signer (evil signer = the wrong-origin attack). */
export async function sealB2A(
  s: Stack,
  opts: { agentBytes: Buffer; seq: number; nB: string; nA?: string; signerPrivateJwk: string },
): Promise<RelayFrame> {
  const blob = await sealRelayEnvelope({
    message: {
      relaySessionId: s.result.relayId,
      routingRef: s.result.ref,
      direction: "B2A",
      seq: opts.seq,
      nB: opts.nB,
      ...(opts.nA === undefined ? {} : { nA: opts.nA }),
      agentBytesB64: base64UrlNoPad(new Uint8Array(opts.agentBytes)),
    },
    privateJwk: JSON.parse(opts.signerPrivateJwk) as JsonWebKey,
    recipient: { principalId: "node:a-node", publicJwk: s.aId.publicJwk },
    seal: mcpSeal,
  });
  return { type: "relay", ref: s.result.ref, seq: opts.seq, direction: "B2A", blob };
}

/** Seal one A2B reply with the given signer (evil signer = the forged-reply attack). */
export async function sealA2B(
  s: Stack,
  opts: { agentBytes: Buffer; seq: number; nB: string; nA?: string; signerPrivateJwk: string },
): Promise<RelayFrame> {
  const blob = await sealRelayEnvelope({
    message: {
      relaySessionId: s.result.relayId,
      routingRef: s.result.ref,
      direction: "A2B",
      seq: opts.seq,
      nB: opts.nB,
      ...(opts.nA === undefined ? {} : { nA: opts.nA }),
      agentBytesB64: base64UrlNoPad(new Uint8Array(opts.agentBytes)),
    },
    privateJwk: JSON.parse(opts.signerPrivateJwk) as JsonWebKey,
    recipient: { principalId: "node:b-node", publicJwk: s.bId.publicJwk },
    seal: mcpSeal,
  });
  return { type: "relay", ref: s.result.ref, seq: opts.seq, direction: "A2B", blob };
}

/* ------------------------------------------------------------------ */
/* tiny async helpers                                                  */
/* ------------------------------------------------------------------ */

/** Sleep. */
export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Wait until `cond` holds or throw with a named timeout. */
export async function waitUntil(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
