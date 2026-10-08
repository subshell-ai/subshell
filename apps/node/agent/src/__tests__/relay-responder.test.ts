import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as mcpOpen, seal as mcpSeal } from "@internal/mcp-core";
import {
  base64UrlNoPad,
  newNonce,
  openRelayEnvelope,
  parseRelayFrame,
  type RelayFrame,
  SSH_RELAY_MAX_PER_NODE,
  type SshRelayOpenCommand,
  sealRelayEnvelope,
  verifyRelayEnvelope,
} from "@internal/subshell-protocol";
import { exportJWK, generateKeyPair } from "jose";
import { openARelaySession, openBRelaySession, RelaySessions } from "../commands/ssh-relay.js";
import { loadOrCreateIdentity } from "../identity.js";
import { type AgentScheme, CLASSIC_SCHEME, OPENSSH_10X_SCHEME } from "../relay-agent-scheme.js";
import { buildAgentSocketPath } from "../relay-proxy.js";
import { startRelayResponder } from "../relay-responder.js";

/**
 * The A-side responder (spec 2026-10-08 §5.4/§5.6) under the PROBED numbering
 * ruling (ruling 2026-10-08): the session probes A's live agent once at
 * relay-open to learn which codepoint scheme it speaks, caches that scheme on
 * the session, then classifies and scopes every request in it. The stub
 * agents below answer with real-agent byte literals for BOTH schemes - the
 * fixtures are written against the measured OpenSSH_10.2p1 behavior (a byte
 * 13 truncated sign answers FAILURE 5; a byte 11 answers a valid 12) and
 * OpenSSH's classic behavior (13 answers 14; 15 signs with 16), never against
 * constants the production module exports, so numeric drift cannot hide.
 * seal/open are the REAL mcp-core pair; the test side computes fingerprints
 * independently (node:crypto over the wire blob).
 */

/* ------------------------------------------------------------------ */
/* the agent wire, spelled by hand                                     */
/* ------------------------------------------------------------------ */

/** An independent fingerprint oracle for the tests: SHA-256, base64url no pad. */
function fp(wire: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(wire).digest("base64url")}`;
}

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** An SSH string on the agent wire: 4-byte BE length + bytes. */
function sshStr(bytes: Buffer | string): Buffer {
  const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.concat([be32(b.length), b]);
}

function buildIdentitiesAnswer(scheme: AgentScheme, entries: { blob: Buffer; comment: string }[]): Buffer {
  return Buffer.concat([
    Buffer.from([scheme.answer]),
    be32(entries.length),
    ...entries.flatMap((e) => [sshStr(e.blob), sshStr(e.comment)]),
  ]);
}

/** A classic-scheme SIGN_REQUEST body: blob, data, flags (the classic wire grammar). */
function buildSignRequestClassic(keyBlob: Buffer, data = Buffer.from("DATA"), flags = 0): Buffer {
  return Buffer.concat([Buffer.from([15]), sshStr(keyBlob), sshStr(data), be32(flags)]);
}

/** A 10.x-scheme SIGN_REQUEST body: blob, data, flags, optional trailing algorithms string. */
function buildSignRequestTenX(
  keyBlob: Buffer,
  opts: { data?: Buffer; flags?: number; algorithms?: string } = {},
): Buffer {
  const parts = [Buffer.from([13]), sshStr(keyBlob), sshStr(opts.data ?? Buffer.from("DATA")), be32(opts.flags ?? 0)];
  if (opts.algorithms !== undefined) parts.push(sshStr(opts.algorithms));
  return Buffer.concat(parts);
}

/** The stub's independent sign-body validity check (mirrors the real agent's parser). */
function isWellFormedSignBody(p: Buffer, scheme: AgentScheme): boolean {
  let off = 1;
  const str = (): Buffer | null => {
    if (off + 4 > p.length) return null;
    const n = p.readUInt32BE(off);
    off += 4;
    if (off + n > p.length) return null;
    const v = Buffer.from(p.subarray(off, off + n));
    off += n;
    return v;
  };
  const blob = str();
  if (blob === null || blob.length === 0) return false;
  if (str() === null) return false; // data
  if (off + 4 > p.length) return false; // flags
  off += 4;
  if (off === p.length) return true;
  if (!scheme.extendedSign) return false; // trailing bytes need the extended grammar
  if (str() === null) return false; // algorithms string must be whole
  return off === p.length;
}

/** Decode an IDENTITIES_ANSWER the test way (independent of the production parser). */
function parseAnswer(answer: Buffer): { type: number; count: number; comments: string[] } {
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

function framed(payload: Buffer): Buffer {
  return Buffer.concat([be32(payload.length), payload]);
}

/* ------------------------------------------------------------------ */
/* the stub live agents: Unix sockets speaking one scheme's bytes      */
/* ------------------------------------------------------------------ */

interface StubAgent {
  path: string;
  /** Every request payload the stub RECEIVED, in order (the probes included). */
  received: Buffer[];
  /**
   * Install an answer mutator AFTER the open-time probe (late binding): the
   * probe must always see a clean agent or the scheme would never resolve;
   * only later replies get corrupted to drive the response gates.
   */
  setMutate(mutate: (kind: "identities" | "sign", answer: Buffer) => Buffer): void;
  close(): Promise<void>;
}

interface RosterEntry {
  blob: Buffer;
  comment: string;
}

/**
 * A stub that behaves like a live agent of the given scheme: a one-byte
 * identities request answers the full roster in that scheme's answer byte; a
 * WELL-FORMED sign body answers SIGN_RESPONSE (it signs anything it is asked:
 * "the forwarded list never contains it" is the witness that the responder
 * refused before forwarding); anything else - including the probe's one-byte
 * classic candidate hitting a 10.x agent, where byte 13 is a truncated sign -
 * answers FAILURE(5), exactly the OpenSSH_10.2p1 measurement. {@link
 * StubAgent.setMutate} can later corrupt would-be-valid answers (foreign type
 * bytes, truncated rosters) to drive the responder's response gates.
 */
async function startStubAgent(roster: RosterEntry[], scheme: AgentScheme): Promise<StubAgent> {
  const dir = mkdtempSync(join(tmpdir(), "subshell-relay-stub-"));
  const path = join(dir, "agent.sock");
  const received: Buffer[] = [];
  const state: { mutate?: (kind: "identities" | "sign", answer: Buffer) => Buffer } = {};
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
          const answer = buildIdentitiesAnswer(scheme, roster);
          conn.write(framed(state.mutate ? state.mutate("identities", answer) : answer));
        } else if (type === scheme.sign && isWellFormedSignBody(request, scheme)) {
          const answer = Buffer.concat([Buffer.from([scheme.signResponse]), sshStr(Buffer.from("SIG"))]);
          conn.write(framed(state.mutate ? state.mutate("sign", answer) : answer));
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
  return {
    path,
    received,
    setMutate: (mutate) => {
      state.mutate = mutate;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A stub answering FAILURE(5) to EVERY request: it speaks neither scheme. */
async function startUnprobeableAgent(): Promise<StubAgent> {
  const dir = mkdtempSync(join(tmpdir(), "subshell-relay-stub-"));
  const path = join(dir, "agent.sock");
  const received: Buffer[] = [];
  const server: Server = createServer((conn: Socket) => {
    let buffer = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) return;
      received.push(Buffer.from(buffer.subarray(4, 4 + len)));
      buffer = buffer.subarray(4 + len);
      conn.write(framed(Buffer.from([5])));
    });
    conn.on("error", () => {
      /* per-request closes; never throw */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(path);
  });
  return {
    path,
    received,
    setMutate: () => {
      /* this stub never produces a valid answer to corrupt */
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* ------------------------------------------------------------------ */
/* machine identities                                                  */
/* ------------------------------------------------------------------ */

interface JwkPair {
  publicJwk: string;
  privateJwk: string;
}

async function es256Pair(): Promise<JwkPair> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    publicJwk: JSON.stringify(await exportJWK(publicKey)),
    privateJwk: JSON.stringify(await exportJWK(privateKey)),
  };
}

async function ecdhPair(): Promise<JwkPair> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  return {
    publicJwk: JSON.stringify(await exportJWK(publicKey)),
    privateJwk: JSON.stringify(await exportJWK(privateKey)),
  };
}

async function machineKeys(): Promise<{ signing: JwkPair; encryption: JwkPair }> {
  const [signing, encryption] = await Promise.all([es256Pair(), ecdhPair()]);
  return { signing, encryption };
}

// B = the connecting machine (test-generated keys); A = this machine, whose
// identity the responder loads from the data dir through identity.ts itself.
const bKeysReady = machineKeys();
/** An ES256 pair nobody pinned: requests signed with it are forgeries. */
const evilKeysReady: Promise<JwkPair> = es256Pair();

/* ------------------------------------------------------------------ */
/* the fixture: a brokered A session over RelaySessions + a stub agent */
/* ------------------------------------------------------------------ */

const KEY_IN = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("ssh-ed25519"), sshStr(Buffer.from("KEY-IN"))]);
const KEY_OUT = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("ssh-ed25519"), sshStr(Buffer.from("KEY-OUT"))]);
// Task 12: the destination's pinned known_hosts line the relay-open carries.
const HOST_PIN = "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000";
const ROSTER: RosterEntry[] = [
  { blob: KEY_IN, comment: "granted key" },
  { blob: KEY_OUT, comment: "ungranted key" },
];

interface Fixture {
  relay: RelaySessions;
  frames: RelayFrame[];
  stub: StubAgent;
  /** Messages the stub received AFTER the open-time probe finished. */
  forwarded(): Buffer[];
  dataDir: string;
  aPublic: { signing: string; encryption: string };
  aPrivate: { signing: string; encryption: string };
  bKeys: { signing: JwkPair; encryption: JwkPair };
  /** The scheme the stub agent speaks and the probe is expected to resolve. */
  scheme: AgentScheme;
  cleanup(): Promise<void>;
}

/**
 * Open the A side with the shipped command shape through the real registration
 * path. The numbering probe runs INSIDE openARelaySession, so by the time this
 * resolves the stub has already fielded the probe bytes; everything received
 * after that point is what the responder forwarded for B's requests.
 */
async function openFixture(
  overrides: Partial<SshRelayOpenCommand> = {},
  opts: {
    resolveAgentSocket?: () => string | null;
    send?: (frame: RelayFrame) => void;
    scheme?: AgentScheme;
    roster?: RosterEntry[];
    unprobeable?: boolean;
    mutateAnswer?: (kind: "identities" | "sign", answer: Buffer) => Buffer;
  } = {},
): Promise<Fixture> {
  const scheme = opts.scheme ?? OPENSSH_10X_SCHEME;
  const bKeys = await bKeysReady;
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-responder-"));
  // The responder loads A's identity from the data dir; mint it first so the
  // test side knows A's keys (loadOrCreateIdentity is idempotent per dir).
  const aIdentity = await loadOrCreateIdentity(dataDir);
  const stub = opts.unprobeable ? await startUnprobeableAgent() : await startStubAgent(opts.roster ?? ROSTER, scheme);
  const relay = new RelaySessions();
  const frames: RelayFrame[] = [];
  const cmd: SshRelayOpenCommand = {
    type: "ssh_relay_open",
    relayId: "relay-1",
    ref: "r-1",
    role: "A",
    aNodeId: "a-node",
    bNodeId: "b-node",
    peerSigningPublicKey: bKeys.signing.publicJwk,
    peerEncryptPublicKey: Buffer.from(bKeys.encryption.publicJwk, "utf8").toString("base64"),
    grantId: "grant-1",
    fingerprints: [fp(KEY_IN)],
    lifetimeMs: 30_000,
    paneId: "pane-a-test", // grammar (b): the command names the pane
    hostPin: HOST_PIN, // grammar (Task 12): the destination's pinned key line
    ...overrides,
  };
  await openARelaySession({
    relay,
    dataDir,
    selfNodeId: "a-node",
    cmd,
    sendRelayFrame:
      opts.send ??
      ((frame: RelayFrame): void => {
        frames.push(frame);
      }),
    resolveAgentSocket: opts.resolveAgentSocket ?? ((): string => stub.path),
  });
  const probeCount = stub.received.length; // whatever the open-time probe asked
  if (opts.mutateAnswer) stub.setMutate(opts.mutateAnswer); // corrupt only post-probe answers
  return {
    relay,
    frames,
    stub,
    forwarded: (): Buffer[] => stub.received.slice(probeCount),
    dataDir,
    aPublic: { signing: aIdentity.signingPublicJwk, encryption: aIdentity.publicJwk },
    aPrivate: { signing: aIdentity.signingPrivateJwk, encryption: aIdentity.privateJwk },
    bKeys,
    scheme,
    cleanup: async () => {
      relay.closeAll("lifetime-expiry");
      await stub.close();
    },
  };
}

/** Seal one B2A request exactly as B's proxy does (Task 6 wire posture). */
async function sealRequest(
  f: Fixture,
  opts: {
    agentBytes: Buffer;
    seq: number;
    nB: string;
    nA?: string;
    signerPrivateJwk?: string;
    relaySessionId?: string;
    ref?: string;
    direction?: "B2A" | "A2B";
  },
): Promise<RelayFrame> {
  const blob = await sealRelayEnvelope({
    message: {
      relaySessionId: opts.relaySessionId ?? "relay-1",
      routingRef: opts.ref ?? "r-1",
      direction: opts.direction ?? "B2A",
      seq: opts.seq,
      nB: opts.nB,
      ...(opts.nA === undefined ? {} : { nA: opts.nA }),
      agentBytesB64: base64UrlNoPad(new Uint8Array(opts.agentBytes)),
    },
    privateJwk: JSON.parse(opts.signerPrivateJwk ?? f.bKeys.signing.privateJwk) as JsonWebKey,
    recipient: { principalId: "node:a-node", publicJwk: f.aPublic.encryption },
    seal: mcpSeal,
  });
  const direction = opts.direction ?? "B2A";
  return { type: "relay", ref: opts.ref ?? "r-1", seq: opts.seq, direction, blob };
}

/** Open + verify one A2B frame AS B: the mirror of A's inbound checklist. */
async function decodeA2B(
  f: Fixture,
  frame: RelayFrame,
  expect: { nB: string; nA?: string },
): Promise<{ agentBytes: Buffer; nA?: string; seq: number }> {
  const opened = await openRelayEnvelope({
    blob: frame.blob,
    own: {
      principalId: "node:b-node",
      publicJwk: f.bKeys.encryption.publicJwk,
      privateJwk: f.bKeys.encryption.privateJwk,
    },
    open: mcpOpen,
    expect: { ref: frame.ref, direction: frame.direction },
  });
  const message = await verifyRelayEnvelope({
    jws: opened.jws,
    publicJwk: JSON.parse(f.aPublic.signing) as JsonWebKey,
    expect: {
      routingRef: frame.ref,
      direction: "A2B",
      seq: opened.seq,
      relaySessionId: "relay-1",
      nB: expect.nB,
      ...(expect.nA === undefined ? {} : { nA: expect.nA }),
    },
  });
  return {
    agentBytes: Buffer.from(message.agentBytesB64, "base64url"),
    nA: message.nA,
    seq: opened.seq,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/* ------------------------------------------------------------------ */
/* the open-time probe (the 2026-10-08 numbering ruling)               */
/* ------------------------------------------------------------------ */

test("opening a session on a 10.x agent probes classic-then-10.x, resolves on the 11-to-12 answer, and forwards nothing", async () => {
  const f = await openFixture(); // the 10.x stub is the fleet default (measured OpenSSH_10.2p1)
  try {
    // Byte 13 first: the 10.x stub reads it as a truncated sign and answers
    // FAILURE(5), the measured behavior. Byte 11 then answers a valid
    // IDENTITIES_ANSWER(12): the scheme resolves positively on the 11-to-12 pair.
    expect(f.stub.received).toEqual([Buffer.from([13]), Buffer.from([11])]);
    // The probe's roster is A's own view of the world: it never rides to B.
    expect(f.frames.length).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("opening a session on a classic agent resolves on the 13-to-14 answer in a single probe", async () => {
  const f = await openFixture({}, { scheme: CLASSIC_SCHEME });
  try {
    expect(f.stub.received).toEqual([Buffer.from([13])]);
    expect(f.frames.length).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("the probe never sends anything but one-byte identities requests (it can never ask for a signature)", async () => {
  const f = await openFixture();
  try {
    for (const payload of f.stub.received) {
      expect(payload.length).toBe(1);
      expect([11, 13]).toContain(payload[0]);
    }
  } finally {
    await f.cleanup();
  }
});

test("an agent the probe cannot resolve refuses every request and forwards nothing beyond the probes", async () => {
  const f = await openFixture({}, { unprobeable: true }); // FAILURE(5) to everything
  try {
    expect(f.stub.received).toEqual([Buffer.from([13]), Buffer.from([11])]); // both candidates tried
    const nB = newNonce();
    // Every byte SOME scheme would honor must be refused while the scheme is
    // unresolved: never forwarded under a guessed interpretation.
    const requests = [
      Buffer.from([11]),
      buildSignRequestTenX(KEY_IN),
      Buffer.from([13]),
      buildSignRequestClassic(KEY_IN),
    ];
    let nA: string | undefined;
    for (const [i, agentBytes] of requests.entries()) {
      const req = await sealRequest(f, { agentBytes, seq: i, nB, ...(nA === undefined ? {} : { nA }) });
      f.relay.onInboundRelayFrame(req);
      await waitUntil(() => f.frames.length === i + 1, `refusal ${i}`);
      const reply = await decodeA2B(f, f.frames[i], { nB, ...(nA === undefined ? {} : { nA }) });
      expect([...reply.agentBytes]).toEqual([5]);
      nA = reply.nA; // later requests must carry the recorded nonce onward (real B's state)
    }
    expect(f.forwarded()).toEqual([]); // nothing beyond the two one-byte probes
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the 10.x scheme: identities 11/answer 12, sign 13/response 14       */
/* ------------------------------------------------------------------ */

test("under the 10.x scheme a REQUEST_IDENTITIES (11) from pinned B gets an IDENTITIES_ANSWER (12) filtered to the grant, and the session's second request rides the recorded nA", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const req1 = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    expect(parseRelayFrame(JSON.stringify(req1))).not.toBeNull();
    f.relay.onInboundRelayFrame(req1);
    await waitUntil(() => f.frames.length === 1, "one A2B reply frame");

    const frame1 = f.frames[0];
    expect(frame1.type).toBe("relay");
    expect(frame1.ref).toBe("r-1");
    expect(frame1.direction).toBe("A2B");
    expect(frame1.seq).toBe(0);
    const reply1 = await decodeA2B(f, frame1, { nB });
    expect(reply1.nA).toMatch(/^[A-Za-z0-9_-]{22}$/); // A minted its endpoint nonce (§5.6)
    expect(reply1.seq).toBe(0); // the signed seq of the first reply

    const answer = parseAnswer(reply1.agentBytes);
    expect(answer.type).toBe(12); // the 10.x answer byte, never an invented 2 (C-1)
    expect(answer.count).toBe(1); // the stub roster had 2; only the granted fingerprint survives
    expect(answer.comments).toEqual(["granted key"]);
    expect(f.forwarded()[0]).toEqual(Buffer.from([11])); // the agent saw the identities request

    // The second request carries A's recorded nonce; A's expect binds it onward.
    // The 10.x extended grammar: blob, data, flags, trailing algorithms string.
    const signReq = buildSignRequestTenX(KEY_IN, { algorithms: "ssh-ed25519" });
    const req2 = await sealRequest(f, { agentBytes: signReq, seq: 1, nB, nA: reply1.nA });
    f.relay.onInboundRelayFrame(req2);
    await waitUntil(() => f.frames.length === 2, "the second A2B reply frame");
    const reply2 = await decodeA2B(f, f.frames[1], { nB, nA: reply1.nA });
    expect(f.frames[1].seq).toBe(1); // transport seq advanced
    expect(reply2.seq).toBe(1); // signed anti-replay seq advanced
    expect(reply2.nA).toBe(reply1.nA); // every A2B carries the SAME nA (Task-6 handoff)
    expect([...reply2.agentBytes]).toEqual([14, 0, 0, 0, 3, ...Buffer.from("SIG")]); // SIGN_RESPONSE 14
    expect(f.forwarded()[1]).toEqual(signReq); // byte-identical forward, extended grammar included
  } finally {
    await f.cleanup();
  }
});

test("C-2 regression: a crafted byte-13 SIGN_REQUEST under the 10.x scheme with an OUT-of-grant blob is refused and never forwarded", async () => {
  // Byte 13 is SIGN under 10.x. Before the fix the responder treated it as
  // the classic identities request and forwarded it raw, unscoped, so A's
  // agent would have signed an attacker-chosen blob. Now the probe resolves
  // 10.x and the fingerprint scope must reject it BEFORE any forward.
  const f = await openFixture();
  try {
    const nB = newNonce();
    const crafted = buildSignRequestTenX(KEY_OUT); // KEY_OUT is not in the grant
    const req = await sealRequest(f, { agentBytes: crafted, seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "a refusal reply frame");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]); // SSH2_AGENT_FAILURE
    await sleep(30);
    expect(f.forwarded()).toEqual([]); // §5.4: checked at the responder, never forwarded
    // And the byte-13 traffic the stub saw is only the one-byte probe, never
    // the crafted body.
    for (const seen of f.stub.received) {
      if (seen[0] === 13) expect(seen.length).toBe(1);
    }
  } finally {
    await f.cleanup();
  }
});

test("under the 10.x scheme every codepoint the scheme does not name is refused and never forwarded (default-deny)", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    // 15/16 are the CLASSIC sign request/response bytes; 14 is 10.x's own
    // response byte aimed at us as a request; the rest are agent-proto.h
    // mutations/locks/SSH1 codes. NONE is 10.x identities (11) or sign (13).
    const disallowed = [15, 16, 14, 17, 18, 19, 22, 23, 27, 1, 200];
    let nA: string | undefined;
    for (const [i, type] of disallowed.entries()) {
      const req = await sealRequest(f, {
        agentBytes: Buffer.from([type, 1, 2, 3]),
        seq: i,
        nB,
        ...(nA === undefined ? {} : { nA }),
      });
      f.relay.onInboundRelayFrame(req);
      await waitUntil(() => f.frames.length === i + 1, `a refusal for disallowed type ${type}`);
      const reply = await decodeA2B(f, f.frames[i], { nB, ...(nA === undefined ? {} : { nA }) });
      expect([...reply.agentBytes]).toEqual([5]);
      expect(f.frames[i].seq).toBe(i);
      nA = reply.nA; // later requests must carry the recorded nonce onward (real B's state)
    }
    await sleep(30);
    expect(f.forwarded()).toEqual([]); // nothing reached A's agent
  } finally {
    await f.cleanup();
  }
});

test("under the 10.x scheme malformed sign bodies are refused and never forwarded", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    let nA: string | undefined;
    const malformed: Buffer[] = [
      Buffer.from([13, 0, 0, 0, 2]), // truncated blob length
      Buffer.concat([Buffer.from([13]), sshStr(KEY_IN)]), // blob-only: no data, no flags
      Buffer.concat([Buffer.from([13]), sshStr(KEY_IN), be32(0)]), // blob+flags: not the wire grammar
      Buffer.concat([Buffer.from([13]), sshStr(KEY_IN), sshStr("DATA")]), // missing flags
      Buffer.concat([Buffer.from([13]), sshStr(Buffer.alloc(0)), sshStr("DATA"), be32(0)]), // empty blob
      Buffer.concat([Buffer.from([13]), sshStr(KEY_IN), sshStr("DATA"), be32(0), Buffer.from([0, 0])]), // junk tail
      Buffer.concat([
        Buffer.from([13]),
        sshStr(KEY_IN),
        sshStr("DATA"),
        be32(0),
        Buffer.from([0, 0, 0, 99]), // algorithms string longer than the buffer
      ]),
    ];
    for (const [i, agentBytes] of malformed.entries()) {
      const req = await sealRequest(f, { agentBytes, seq: i, nB, ...(nA === undefined ? {} : { nA }) });
      f.relay.onInboundRelayFrame(req);
      await waitUntil(() => f.frames.length === i + 1, `a refusal for malformed body ${i}`);
      const reply = await decodeA2B(f, f.frames[i], { nB, ...(nA === undefined ? {} : { nA }) });
      expect([...reply.agentBytes]).toEqual([5]);
      nA = reply.nA;
    }
    await sleep(30);
    expect(f.forwarded()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("under the 10.x scheme a REQUEST_IDENTITIES (11) must be exactly one byte (extra bytes are refused, not forwarded)", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([11, 0, 1, 2, 3]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the refusal");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]);
    await sleep(30);
    expect(f.forwarded()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("under the 10.x scheme a grant naming no fingerprint serves the count-zero answer (12), never the roster", async () => {
  const f = await openFixture({ fingerprints: [] });
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the filtered reply frame");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    // The full two-key roster is on the stub; the answer is five bytes: 12 + count 0.
    expect([...reply.agentBytes]).toEqual([12, 0, 0, 0, 0]);
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the classic scheme: identities 13/answer 14, sign 15/response 16    */
/* ------------------------------------------------------------------ */

test("under the classic scheme a REQUEST_IDENTITIES (13) gets an IDENTITIES_ANSWER (14) filtered to the grant", async () => {
  const f = await openFixture({}, { scheme: CLASSIC_SCHEME });
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([13]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "one A2B reply frame");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    const answer = parseAnswer(reply.agentBytes);
    expect(answer.type).toBe(14); // the classic answer byte
    expect(answer.count).toBe(1);
    expect(answer.comments).toEqual(["granted key"]);
    expect(f.forwarded()[0]).toEqual(Buffer.from([13])); // byte 13 IS identities here
  } finally {
    await f.cleanup();
  }
});

test("under the classic scheme a SIGN_REQUEST (15) is scoped by fingerprint and a granted one rides byte-identical", async () => {
  const f = await openFixture({}, { scheme: CLASSIC_SCHEME });
  try {
    const nB = newNonce();
    const outOfSet = buildSignRequestClassic(KEY_OUT);
    const bad = await sealRequest(f, { agentBytes: outOfSet, seq: 0, nB });
    f.relay.onInboundRelayFrame(bad);
    await waitUntil(() => f.frames.length === 1, "the out-of-set refusal");
    const refusal = await decodeA2B(f, f.frames[0], { nB });
    expect([...refusal.agentBytes]).toEqual([5]);
    expect(f.forwarded()).toEqual([]); // out-of-set never reached the agent

    const inSet = buildSignRequestClassic(KEY_IN);
    const good = await sealRequest(f, { agentBytes: inSet, seq: 1, nB, nA: refusal.nA });
    f.relay.onInboundRelayFrame(good);
    await waitUntil(() => f.frames.length === 2, "the signature reply");
    const reply = await decodeA2B(f, f.frames[1], { nB, nA: refusal.nA });
    expect([...reply.agentBytes]).toEqual([16, 0, 0, 0, 3, ...Buffer.from("SIG")]); // SIGN_RESPONSE 16
    expect(f.forwarded()[0]).toEqual(inSet);
  } finally {
    await f.cleanup();
  }
});

test("under the classic scheme the 10.x bytes and non-grammatical bodies are refused and never forwarded", async () => {
  const f = await openFixture({}, { scheme: CLASSIC_SCHEME });
  try {
    const nB = newNonce();
    let nA: string | undefined;
    const cases = [
      Buffer.from([11]), // 10.x identities: a classic agent has no such request
      Buffer.from([12]), // 10.x's answer byte aimed at us as a request
      Buffer.from([13, 9]), // classic identities must be exactly one byte
      buildSignRequestClassic(KEY_IN).subarray(0, 5), // truncated before data
      buildSignRequestTenX(KEY_IN), // byte 13 with a full body: 13 must be one byte here
      Buffer.concat([buildSignRequestClassic(KEY_IN), sshStr("ssh-ed25519")]), // trailing algorithms: the extended grammar belongs to 10.x
    ];
    for (const [i, agentBytes] of cases.entries()) {
      const req = await sealRequest(f, { agentBytes, seq: i, nB, ...(nA === undefined ? {} : { nA }) });
      f.relay.onInboundRelayFrame(req);
      await waitUntil(() => f.frames.length === i + 1, `a refusal for case ${i}`);
      const reply = await decodeA2B(f, f.frames[i], { nB, ...(nA === undefined ? {} : { nA }) });
      expect([...reply.agentBytes]).toEqual([5]);
      nA = reply.nA;
    }
    await sleep(30);
    expect(f.forwarded()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* agent answers that misbehave (the response gates)                   */
/* ------------------------------------------------------------------ */

test("an agent answering identities with a FOREIGN type byte becomes a refusal, never a forward-through", async () => {
  // The 10.x session asks [11]; the stub answers a well-formed roster spelled
  // with the classic 14 (the collision byte). The resolved scheme's answer
  // gate must refuse it: 14 is a SIGN_RESPONSE here, not a roster.
  const f = await openFixture({}, { mutateAnswer: (_kind, answer) => Buffer.from([14, ...answer.subarray(1)]) });
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the refusal");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]);
  } finally {
    await f.cleanup();
  }
});

test("an unparseable roster never rides on: partial parsing is exactly what §5.4 exists to prevent", async () => {
  // A valid 12 header whose declared entries the buffer does not carry.
  const f = await openFixture({}, { mutateAnswer: (_kind, answer) => answer.subarray(0, answer.length - 4) });
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the refusal");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]);
  } finally {
    await f.cleanup();
  }
});

test("regression: a SIGN_RESPONSE of exactly the type byte plus one string rides on in BOTH schemes", async () => {
  // The strict body parse accepts the honest shape in each scheme and forwards
  // it byte-identical: 10.x's [14, string] and classic's [16, string].
  for (const [scheme, responseByte, signReq] of [
    [OPENSSH_10X_SCHEME, 14, buildSignRequestTenX(KEY_IN)],
    [CLASSIC_SCHEME, 16, buildSignRequestClassic(KEY_IN)],
  ] as [AgentScheme, number, Buffer][]) {
    const f = await openFixture({}, { scheme });
    try {
      const nB = newNonce();
      const req = await sealRequest(f, { agentBytes: signReq, seq: 0, nB });
      f.relay.onInboundRelayFrame(req);
      await waitUntil(() => f.frames.length === 1, `the ${scheme.name} signature reply`);
      const reply = await decodeA2B(f, f.frames[0], { nB });
      expect([...reply.agentBytes]).toEqual([responseByte, 0, 0, 0, 3, ...Buffer.from("SIG")]);
    } finally {
      await f.cleanup();
    }
  }
});

test("collision regression: a classic roster answering under byte 14 is refused by a 10.x session's sign gate", async () => {
  // classic answer 14 == 10.x signResponse 14. A mid-session swap of A's agent
  // to a classic build reads the forwarded byte 13 (10.x sign) as classic
  // REQUEST_IDENTITIES and answers its FULL UNFILTERED roster under type 14 -
  // exactly the byte a type-only gate would wave through to B as a sign
  // response, leaking public blobs plus comments. The strictly parsed body
  // must refuse the roster shape; B sees only the clean FAILURE.
  const rosterUnder14 = Buffer.concat([
    Buffer.from([14]),
    be32(2),
    sshStr(KEY_IN),
    sshStr("granted key"),
    sshStr(KEY_OUT),
    sshStr("ungranted key"),
  ]);
  const f = await openFixture(
    {},
    { scheme: OPENSSH_10X_SCHEME, mutateAnswer: (kind, answer) => (kind === "sign" ? rosterUnder14 : answer) },
  );
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: buildSignRequestTenX(KEY_IN), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the refusal");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]); // never the roster
    expect(f.forwarded().length).toBe(1); // the scoped sign request DID reach the agent
  } finally {
    await f.cleanup();
  }
});

test("regression: a roster-shaped body under classic's SIGN_RESPONSE byte 16 is refused too", async () => {
  // Not a real-world collision (classic's roster answer is 14): the point is
  // the gate parses the BODY, so a multi-string roster under the response
  // byte is refused whichever agent spelled it.
  const rosterUnder16 = Buffer.concat([
    Buffer.from([16]),
    be32(2),
    sshStr(KEY_IN),
    sshStr("granted key"),
    sshStr(KEY_OUT),
    sshStr("ungranted key"),
  ]);
  const f = await openFixture(
    {},
    { scheme: CLASSIC_SCHEME, mutateAnswer: (kind, answer) => (kind === "sign" ? rosterUnder16 : answer) },
  );
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: buildSignRequestClassic(KEY_IN), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the refusal");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]); // never the roster
    expect(f.forwarded().length).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("an agent answering a granted sign with a FOREIGN response byte becomes a refusal (the signature never rides)", async () => {
  // The 10.x session forwards byte 13; the stub answers type 16 (the classic
  // SIGN_RESPONSE) with a signature: under the resolved 10.x scheme that is
  // not a legal answer, and the bytes must never reach B.
  const f = await openFixture(
    {},
    { mutateAnswer: (kind, answer) => (kind === "sign" ? Buffer.from([16, ...answer.subarray(1)]) : answer) },
  );
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: buildSignRequestTenX(KEY_IN), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the refusal");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]);
    expect(f.forwarded().length).toBe(1); // the scoped request DID ride; its answer did not
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* origin and replay: a refusal sends nothing and forwards nothing     */
/* ------------------------------------------------------------------ */

test("a request signed by a key that is not B's pin is refused: no reply frame, nothing forwarded", async () => {
  const f = await openFixture();
  const evil = await evilKeysReady;
  try {
    const req = await sealRequest(f, {
      agentBytes: Buffer.from([11]),
      seq: 0,
      nB: newNonce(),
      signerPrivateJwk: evil.privateJwk,
    });
    f.relay.onInboundRelayFrame(req);
    await sleep(50);
    expect(f.frames.length).toBe(0);
    expect(f.forwarded()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("a request bound to a foreign relay-session id or a foreign nB nonce is refused", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    // Cross-session replay: right keys, another session's id.
    const wrongSession = await sealRequest(f, {
      agentBytes: Buffer.from([11]),
      seq: 0,
      nB,
      relaySessionId: "relay-EVIL",
    });
    f.relay.onInboundRelayFrame(wrongSession);
    await sleep(50);
    expect(f.frames.length).toBe(0);

    // Land the genuine first request so nB is recorded...
    const good = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(good);
    await waitUntil(() => f.frames.length === 1, "the genuine reply");
    const first = await decodeA2B(f, f.frames[0], { nB });

    // ...then a second-seq request carrying a nonce this session never saw.
    const foreignNonce = await sealRequest(f, {
      agentBytes: Buffer.from([11]),
      seq: 1,
      nB: newNonce(),
      nA: first.nA,
    });
    f.relay.onInboundRelayFrame(foreignNonce);
    await sleep(50);
    expect(f.frames.length).toBe(1); // no reply to the foreign nonce
    expect(f.forwarded().length).toBe(1); // and nothing further reached the agent
  } finally {
    await f.cleanup();
  }
});

test("a replayed or non-increasing-seq request is refused: no reply frame, nothing forwarded; the session continues", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const good = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(good);
    await waitUntil(() => f.frames.length === 1, "the first genuine reply");
    const first = await decodeA2B(f, f.frames[0], { nB });

    // Byte-identical resend of the first frame (the plane can resend anything).
    f.relay.onInboundRelayFrame(good);
    // A freshly signed request that rewinds the seq (the signature binds seq).
    const rewind = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB, nA: first.nA });
    f.relay.onInboundRelayFrame(rewind);
    await sleep(50);
    expect(f.frames.length).toBe(1);
    expect(f.forwarded().length).toBe(1);

    // The session still works after refusals: seq 1 advances.
    const next = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 1, nB, nA: first.nA });
    f.relay.onInboundRelayFrame(next);
    await waitUntil(() => f.frames.length === 2, "the next-seq reply still lands");
  } finally {
    await f.cleanup();
  }
});

test("a frame on another ref or with the A2B direction never reaches the responder path", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    // Another ref: the registry itself drops it (the unbrokered-session case).
    const foreignRef = await sealRequest(f, {
      agentBytes: Buffer.from([11]),
      seq: 0,
      nB,
      ref: "r-EVIL",
    });
    f.relay.onInboundRelayFrame(foreignRef);
    // The wrong direction for A's side (B's own echo posture).
    const echo = await sealRequest(f, {
      agentBytes: Buffer.from([11]),
      seq: 0,
      nB,
      direction: "A2B",
    });
    f.relay.onInboundRelayFrame(echo);
    await sleep(50);
    expect(f.frames.length).toBe(0);
    expect(f.forwarded()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* registration: openARelaySession's guards + the relay-open carriage  */
/* ------------------------------------------------------------------ */

type OpenCmdBase = Omit<SshRelayOpenCommand, "ref" | "peerSigningPublicKey" | "peerEncryptPublicKey">;

test("openARelaySession refuses a command that does not name this machine in its role, and the B branch guards its own", async () => {
  const bKeys = await bKeysReady;
  const relay = new RelaySessions();
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-responder-"));
  const encB64 = Buffer.from(bKeys.encryption.publicJwk, "utf8").toString("base64");
  const base: OpenCmdBase = {
    type: "ssh_relay_open",
    relayId: "relay-1",
    role: "A",
    aNodeId: "a-node",
    bNodeId: "b-node",
    grantId: "grant-1",
    fingerprints: [],
    lifetimeMs: 30_000,
    paneId: "pane-a-test",
    hostPin: HOST_PIN,
  };
  // role B: the A branch is not for this command.
  await expect(
    openARelaySession({
      relay,
      dataDir,
      selfNodeId: "a-node",
      cmd: {
        ...base,
        role: "B",
        ref: "r-9",
        peerSigningPublicKey: bKeys.signing.publicJwk,
        peerEncryptPublicKey: encB64,
      },
      sendRelayFrame: () => {},
      resolveAgentSocket: () => null,
    }),
  ).rejects.toThrow(/not the A side/);
  // role A but aNodeId names someone else: not OUR brokered session.
  await expect(
    openARelaySession({
      relay,
      dataDir,
      selfNodeId: "a-node",
      cmd: {
        ...base,
        aNodeId: "someone-else",
        ref: "r-9",
        peerSigningPublicKey: bKeys.signing.publicJwk,
        peerEncryptPublicKey: encB64,
      },
      sendRelayFrame: () => {},
      resolveAgentSocket: () => null,
    }),
  ).rejects.toThrow(/not the key home/);
  // The mirrored guard on the B branch: bNodeId must name the receiver too.
  await expect(
    openBRelaySession({
      relay,
      dataDir,
      selfNodeId: "b-node",
      paneId: "pane-guard",
      cmd: {
        ...base,
        role: "B",
        bNodeId: "someone-else",
        ref: "r-8",
        peerSigningPublicKey: bKeys.signing.publicJwk,
        peerEncryptPublicKey: encB64,
      },
      sendRelayFrame: () => {},
    }),
  ).rejects.toThrow(/not the connecting side/);
  expect(relay.size).toBe(0);
});

test("openARelaySession enforces §4.4 byte-equality on B's pin and the duplicate-ref rule", async () => {
  const f = await openFixture(); // first pairing pinned b-node with bKeys
  try {
    const otherB = await machineKeys();
    const base: OpenCmdBase = {
      type: "ssh_relay_open",
      relayId: "relay-2",
      role: "A",
      aNodeId: "a-node",
      bNodeId: "b-node",
      grantId: "grant-1",
      fingerprints: [],
      lifetimeMs: 30_000,
      paneId: "pane-a-test",
      hostPin: HOST_PIN,
    };
    // A moved signing half under the SAME peer id: a hard block, never a silent overwrite.
    await expect(
      openARelaySession({
        relay: f.relay,
        dataDir: f.dataDir,
        selfNodeId: "a-node",
        cmd: {
          ...base,
          ref: "r-2",
          peerSigningPublicKey: otherB.signing.publicJwk,
          peerEncryptPublicKey: Buffer.from(otherB.encryption.publicJwk, "utf8").toString("base64"),
        },
        sendRelayFrame: () => {},
        resolveAgentSocket: () => null,
      }),
    ).rejects.toThrow(/pin for b-node has MOVED/);
    // Same pinned pairing, already-owned ref: refused, registry untouched.
    await expect(
      openARelaySession({
        relay: f.relay,
        dataDir: f.dataDir,
        selfNodeId: "a-node",
        cmd: {
          ...base,
          relayId: "relay-3",
          ref: "r-1",
          peerSigningPublicKey: f.bKeys.signing.publicJwk,
          peerEncryptPublicKey: Buffer.from(f.bKeys.encryption.publicJwk, "utf8").toString("base64"),
        },
        sendRelayFrame: () => {},
        resolveAgentSocket: () => null,
      }),
    ).rejects.toThrow(/routing ref already owned/);
    expect(f.relay.size).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("a pinned peer key that is not a usable public P-256 JWK rejects the session before anything binds", async () => {
  const bKeys = await bKeysReady;
  const relay = new RelaySessions();
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-responder-"));
  // A PRIVATE signing JWK as the pin: bytesOfJwk's deep refusal, not a raw parse error.
  await expect(
    openARelaySession({
      relay,
      dataDir,
      selfNodeId: "a-node",
      cmd: {
        type: "ssh_relay_open",
        relayId: "relay-1",
        ref: "r-1",
        role: "A",
        aNodeId: "a-node",
        bNodeId: "b-node",
        peerSigningPublicKey: bKeys.signing.privateJwk,
        peerEncryptPublicKey: Buffer.from(bKeys.encryption.publicJwk, "utf8").toString("base64"),
        grantId: "grant-1",
        fingerprints: [],
        lifetimeMs: 30_000,
        paneId: "pane-a-test",
      },
      sendRelayFrame: () => {},
      resolveAgentSocket: () => null,
    }),
  ).rejects.toThrow(/relay open refused/);
  expect(relay.size).toBe(0);
});

test("relay.close tears the responder down: later frames produce nothing", async () => {
  const f = await openFixture();
  try {
    expect(f.relay.has("r-1")).toBe(true);
    expect(f.relay.close("r-1", "grant-revoked")).toBe(true);
    expect(f.relay.has("r-1")).toBe(false);
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req); // the registry: unknown ref now, dropped
    await sleep(30);
    expect(f.frames.length).toBe(0);
    expect(f.forwarded()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the live agent socket seam                                          */
/* ------------------------------------------------------------------ */

test("with no live agent socket the session opens with no scheme and answers SSH2_AGENT_FAILURE, touching nothing", async () => {
  const f = await openFixture({}, { resolveAgentSocket: () => null });
  try {
    // Nothing connected at open either: the probe only runs when a socket exists.
    expect(f.stub.received.length).toBe(0);
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([11]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the no-agent refusal reply");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([5]);
    expect(f.stub.received.length).toBe(0); // the stub socket was never connected
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* refused opens release what they bound (fix round T8 MAJOR 1 + 2)    */
/* ------------------------------------------------------------------ */

/**
 * A stub agent that answers EVERY request with FAILURE(5) only after
 * `delayMs`: the open-time numbering probe stays in flight for the whole
 * (delayed) round trip, which is the window the race test drops the plane's
 * close into. Same one-shot wire posture as the real round trips.
 */
async function startLaggingAgent(delayMs: number): Promise<StubAgent> {
  const dir = mkdtempSync(join(tmpdir(), "subshell-relay-lag-"));
  const path = join(dir, "agent.sock");
  const received: Buffer[] = [];
  const server: Server = createServer((conn: Socket) => {
    let buffer = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) return;
      received.push(Buffer.from(buffer.subarray(4, 4 + len)));
      buffer = buffer.subarray(4 + len);
      setTimeout(() => {
        if (!conn.destroyed) conn.write(framed(Buffer.from([5])));
      }, delayMs);
    });
    conn.on("error", () => {
      /* per-request closes; never throw */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(path);
  });
  return {
    path,
    received,
    setMutate: () => {
      /* nothing well-formed to corrupt */
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const REFUSAL_FILLER = { onRelayFrame: () => {}, close: () => {} };

/** A command whose peer keys are REAL P-256 material: these tests must reach
 *  the register step, which sits past every pin gate, so a placeholder JWK
 *  would refuse in the wrong place. */
async function refusalCmd(over: Partial<SshRelayOpenCommand>): Promise<SshRelayOpenCommand> {
  const bKeys = await bKeysReady; // here they stand for the PEER's registered keys
  return {
    type: "ssh_relay_open",
    relayId: "relay-refusal",
    ref: "r-refusal",
    role: "A",
    aNodeId: "a-node",
    bNodeId: "b-node",
    peerSigningPublicKey: bKeys.signing.publicJwk,
    peerEncryptPublicKey: Buffer.from(bKeys.encryption.publicJwk, "utf8").toString("base64"),
    grantId: "grant-1",
    fingerprints: [],
    lifetimeMs: 30_000,
    paneId: "pane-refusal",
    hostPin: HOST_PIN,
    ...over,
  };
}

test("a B open refused at the node cap releases its bound proxy: no socket file survives (fix MAJOR 1)", async () => {
  const relay = new RelaySessions();
  for (let i = 0; i < SSH_RELAY_MAX_PER_NODE; i += 1) expect(relay.register(`fill-${i}`, REFUSAL_FILLER)).toBe(true);
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-cap-"));
  const socketPath = buildAgentSocketPath(dataDir, "pane-cap");
  await expect(
    openBRelaySession({
      relay,
      dataDir,
      selfNodeId: "b-node",
      paneId: "pane-cap",
      cmd: await refusalCmd({ role: "B", ref: "r-cap-9", relayId: "relay-cap-9" }),
      sendRelayFrame: () => {},
    }),
  ).rejects.toThrow(/relay registry full/);
  // The proxy had already listen()ed when the cap THREW out of register: the
  // throw path must run the same release the dup-ref path always ran - the
  // listener closed and the socket name unlinked (close() does both, so the
  // absent name is the witness that the release ran).
  expect(existsSync(socketPath)).toBe(false);
  expect(relay.size).toBe(SSH_RELAY_MAX_PER_NODE);
  relay.closeAll("lifetime-expiry");
});

test("an A open refused at the node cap closes its responder too (fix MAJOR 1, A twin)", async () => {
  const relay = new RelaySessions();
  for (let i = 0; i < SSH_RELAY_MAX_PER_NODE; i += 1) expect(relay.register(`fill-${i}`, REFUSAL_FILLER)).toBe(true);
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-acap-"));
  const lines: string[] = [];
  await expect(
    openARelaySession({
      relay,
      dataDir,
      selfNodeId: "a-node",
      cmd: await refusalCmd({ ref: "r-cap-a", relayId: "relay-cap-a" }),
      sendRelayFrame: () => {},
      resolveAgentSocket: () => null, // no probe: the cap refusal is the registry's own
      log: (line) => lines.push(line),
    }),
  ).rejects.toThrow(/relay registry full/);
  // The responder existed when register threw; the symmetric catch closes it.
  expect(lines.some((l) => l.includes("r-cap-a") && l.includes("A-side responder closed"))).toBe(true);
  expect(relay.size).toBe(SSH_RELAY_MAX_PER_NODE);
  relay.closeAll("lifetime-expiry");
});

test("a close that lands mid-probe wins the race: the late A open is refused and releases its responder (fix MAJOR 2)", async () => {
  const lag = await startLaggingAgent(80); // each probe answer is ~80 ms late
  const relay = new RelaySessions();
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-race-"));
  const lines: string[] = [];
  try {
    // The ack has already left the executor (pending: true); the detached
    // open is inside its probe when the plane's cut arrives - worst-case
    // ~20 s of agent round trips, here 2 x 80 ms of lagging answers.
    const pending = openARelaySession({
      relay,
      dataDir,
      selfNodeId: "a-node",
      cmd: await refusalCmd({ ref: "r-race", relayId: "relay-race" }),
      sendRelayFrame: () => {},
      resolveAgentSocket: () => lag.path,
      log: (line) => lines.push(line),
    });
    await sleep(20); // mid-probe: nothing owns the ref yet
    expect(lag.received.length).toBeGreaterThan(0); // the probe really is running
    expect(relay.close("r-race", "handshake-grace")).toBe(false); // the plane's ssh_relay_close lands first
    await expect(pending).rejects.toThrow(/already closed by the plane/);
    // (b) release: the responder's own close line ran (the probe's one-shot
    // connections are gone by then; nothing was ever forwarded).
    expect(lines.some((l) => l.includes("r-race") && l.includes("A-side responder closed"))).toBe(true);
    // (c) no orphan: the refused late register took no slot...
    expect(relay.size).toBe(0);
    // (d) and the tombstone punishes only THAT ref: a genuinely new session
    // registers normally (the TTL-bounded expiry itself is pinned in
    // commands-ssh-relay.test.ts with an injected clock).
    expect(relay.register("r-fresh", REFUSAL_FILLER)).toBe(true);
    expect(relay.isTombstoned("r-race")).toBe(true);
  } finally {
    relay.closeAll("lifetime-expiry");
    await lag.close();
  }
});

test("a late B open for a ref the plane already closed unbinds its proxy (fix MAJOR 2, B twin)", async () => {
  const relay = new RelaySessions();
  // The plane's cut lands before the open ever registers.
  expect(relay.close("r-late-b", "handshake-grace")).toBe(false);
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-btomb-"));
  const socketPath = buildAgentSocketPath(dataDir, "pane-late");
  await expect(
    openBRelaySession({
      relay,
      dataDir,
      selfNodeId: "b-node",
      paneId: "pane-late",
      cmd: await refusalCmd({ role: "B", ref: "r-late-b", relayId: "relay-late-b" }),
      sendRelayFrame: () => {},
    }),
  ).rejects.toThrow(/already closed by the plane/);
  // The proxy bound, the refused register released it: no socket remains and
  // no slot was taken.
  expect(existsSync(socketPath)).toBe(false);
  expect(relay.size).toBe(0);
  expect(relay.isTombstoned("r-late-b")).toBe(true);
});

/* ------------------------------------------------------------------ */
/* startRelayResponder's own gates                                     */
/* ------------------------------------------------------------------ */

test("startRelayResponder rejects a pinned peer key that is not public P-256 material (the deep bytesOfJwk gate)", () => {
  expect(() =>
    startRelayResponder({
      relayId: "relay-1",
      ref: "r-1",
      selfNodeId: "a-node",
      peerNodeId: "b-node",
      peerSigningJwk: "not even json",
      peerEncryptionJwk: "not even json",
      ownEncryptionPublicJwk: "{}",
      ownEncryptionPrivateJwk: "{}",
      ownSigningPrivateJwk: "{}",
      fingerprints: [],
      agentScheme: OPENSSH_10X_SCHEME,
      seal: mcpSeal,
      open: mcpOpen,
      sendRelayFrame: () => {},
    }),
  ).toThrow(/relay responder: pinned peer key rejected/);
});

/* ------------------------------------------------------------------ */
/* Task 12: the B branch writes the destination's pinned host-key file */
/* ------------------------------------------------------------------ */

test("openBRelaySession writes the delivered pin to the pane's 0600 known_hosts before binding", async () => {
  const aKeys = await machineKeys();
  const relay = new RelaySessions();
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-hostpin-"));
  const cmd: SshRelayOpenCommand = {
    type: "ssh_relay_open",
    relayId: "relay-1",
    ref: "r-pin",
    role: "B",
    aNodeId: "a-node",
    bNodeId: "b-node", // selfNodeId below matches: this machine is B
    peerSigningPublicKey: aKeys.signing.publicJwk,
    peerEncryptPublicKey: Buffer.from(aKeys.encryption.publicJwk, "utf8").toString("base64"),
    grantId: "grant-1",
    fingerprints: [fp(KEY_IN)],
    lifetimeMs: 30_000,
    paneId: "pane-b-test",
    hostPin: HOST_PIN,
  };
  const { socketPath } = await openBRelaySession({
    relay,
    dataDir,
    selfNodeId: "b-node",
    paneId: "pane-b-test",
    cmd,
    sendRelayFrame: () => {},
  });
  try {
    const pinPath = join(dataDir, "ssh", "pane-b-test", "known_hosts");
    // The file is the delivered line, byte-for-byte, plus the trailing
    // newline ssh_config's own file reader expects.
    expect(readFileSync(pinPath, "utf8")).toBe(`${HOST_PIN}\n`);
    // 0600 (enforced past any umask), and the socket bound beside it.
    expect(statSync(pinPath).mode & 0o777).toBe(0o600);
    expect(existsSync(socketPath)).toBe(true);
  } finally {
    relay.closeAll("lifetime-expiry");
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("openBRelaySession refuses a malformed host pin WITHOUT writing a file", async () => {
  const aKeys = await machineKeys();
  const relay = new RelaySessions();
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-badmin-"));
  const cmd: SshRelayOpenCommand = {
    type: "ssh_relay_open",
    relayId: "relay-1",
    ref: "r-bad",
    role: "B",
    aNodeId: "a-node",
    bNodeId: "b-node",
    peerSigningPublicKey: aKeys.signing.publicJwk,
    peerEncryptPublicKey: Buffer.from(aKeys.encryption.publicJwk, "utf8").toString("base64"),
    grantId: "grant-1",
    fingerprints: [fp(KEY_IN)],
    lifetimeMs: 30_000,
    paneId: "pane-bad",
    // A smuggled second entry: the executor's last-station shape check (the
    // grammar refuses this on the wire too, but the write is the trust file).
    hostPin: `host ssh-rsa AAA\nother-host ssh-rsa BBB`,
  };
  await expect(
    openBRelaySession({
      relay,
      dataDir,
      selfNodeId: "b-node",
      paneId: "pane-bad",
      cmd,
      sendRelayFrame: () => {},
    }),
  ).rejects.toThrow(/host pin/);
  // Nothing bound, nothing written: the pane's dir does not even exist.
  expect(existsSync(join(dataDir, "ssh", "pane-bad", "known_hosts"))).toBe(false);
  expect(relay.size).toBe(0);
  rmSync(dataDir, { recursive: true, force: true });
});
