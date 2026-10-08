import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
  type SshRelayOpenCommand,
  sealRelayEnvelope,
  verifyRelayEnvelope,
} from "@internal/subshell-protocol";
import { exportJWK, generateKeyPair } from "jose";
import { openARelaySession, openBRelaySession, RelaySessions } from "../commands/ssh-relay.js";
import { loadOrCreateIdentity } from "../identity.js";
import {
  filterIdentitiesAnswer,
  fingerprintAgentBlob,
  liveAgentSocketPath,
  SSH2_AGENT_FAILURE,
  SSH2_AGENT_IDENTITIES_ANSWER,
  SSH2_AGENT_SIGN_RESPONSE,
  SSH2_AGENTC_REQUEST_IDENTITIES,
  SSH2_AGENTC_SIGN_REQUEST,
  startRelayResponder,
} from "../relay-responder.js";

/**
 * The A-side responder (spec 2026-10-08 §5.4/§5.6): inbound B2A frames are
 * opened, origin-verified against B's PINNED signing key with the full Task-5
 * caller checklist, default-denied by agent method, scoped to the grant's
 * fingerprint set against A's live agent (a stub Unix socket here), and the
 * reply is sealed+signed back as an A2B frame. seal/open are the REAL
 * mcp-core pair, the keys are generated exactly as the protocol and proxy
 * tests do, and the test side computes fingerprints independently (node:crypto
 * over the wire blob) so the scheme is pinned, not echoed.
 */

/* ------------------------------------------------------------------ */
/* the agent wire (OpenSSH `agent-proto.h` values)                     */
/* ------------------------------------------------------------------ */

/**
 * Non-allow-listed request types used as refusals witnesses, named by their
 * OpenSSH `agent-proto.h` values: 17 ADD_IDENTITY, 18 REMOVE_IDENTITY,
 * 19 REMOVE_ALL_IDENTITIES, 22 LOCK, 23 UNLOCK, 27 EXTENSION, and the
 * SSH1-era range starting at 1. (The two FORWARDED types are the production
 * constants imported above.)
 */
const SSH2_AGENTC_ADD_IDENTITY = 17;
const SSH2_AGENTC_REMOVE_IDENTITY = 18;
const SSH2_AGENTC_REMOVE_ALL_IDENTITIES = 19;
const SSH2_AGENTC_LOCK = 22;
const SSH2_AGENTC_UNLOCK = 23;
const SSH2_AGENTC_EXTENSION = 27;
const SSH1_AGENTC_REQUEST_RSA_IDENTITIES = 1;

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

function buildIdentitiesAnswer(entries: { blob: Buffer; comment: string }[]): Buffer {
  return Buffer.concat([
    Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]),
    be32(entries.length),
    ...entries.flatMap((e) => [sshStr(e.blob), sshStr(e.comment)]),
  ]);
}

function buildSignRequest(keyBlob: Buffer, flags = 0): Buffer {
  return Buffer.concat([Buffer.from([SSH2_AGENTC_SIGN_REQUEST]), sshStr(keyBlob), be32(flags)]);
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
/* the stub live agent: a Unix socket that answers the agent wire      */
/* ------------------------------------------------------------------ */

interface StubAgent {
  path: string;
  /** Every request payload the stub RECEIVED: the "never forwarded" witness. */
  received: Buffer[];
  close(): Promise<void>;
}

async function startStubAgent(roster: { blob: Buffer; comment: string }[]): Promise<StubAgent> {
  const dir = mkdtempSync(join(tmpdir(), "subshell-relay-stub-"));
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
        if (type === SSH2_AGENTC_REQUEST_IDENTITIES) {
          conn.write(framed(buildIdentitiesAnswer(roster)));
        } else if (type === SSH2_AGENTC_SIGN_REQUEST) {
          // The stub signs ANYTHING it is asked: "the stub never received it"
          // is the witness that the responder refused before forwarding.
          conn.write(framed(Buffer.concat([Buffer.from([SSH2_AGENT_SIGN_RESPONSE]), sshStr(Buffer.from("SIG"))])));
        } else {
          conn.write(framed(Buffer.from([SSH2_AGENT_FAILURE])));
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
/* the fixture: a brokered A session over RelaySessions + the stub     */
/* ------------------------------------------------------------------ */

const KEY_IN = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("ssh-ed25519"), sshStr(Buffer.from("KEY-IN"))]);
const KEY_OUT = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("ssh-ed25519"), sshStr(Buffer.from("KEY-OUT"))]);
const ROSTER = [
  { blob: KEY_IN, comment: "granted key" },
  { blob: KEY_OUT, comment: "ungranted key" },
];

interface Fixture {
  relay: RelaySessions;
  frames: RelayFrame[];
  stub: StubAgent;
  dataDir: string;
  aPublic: { signing: string; encryption: string };
  aPrivate: { signing: string; encryption: string };
  bKeys: { signing: JwkPair; encryption: JwkPair };
  cleanup(): Promise<void>;
}

/** Open the A side with the shipped command shape through the real registration path. */
async function openFixture(
  overrides: Partial<SshRelayOpenCommand> = {},
  opts: { resolveAgentSocket?: () => string | null; send?: (frame: RelayFrame) => void } = {},
): Promise<Fixture> {
  const bKeys = await bKeysReady;
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-responder-"));
  // The responder loads A's identity from the data dir; mint it first so the
  // test side knows A's keys (loadOrCreateIdentity is idempotent per dir).
  const aIdentity = await loadOrCreateIdentity(dataDir);
  const stub = await startStubAgent(ROSTER);
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
  return {
    relay,
    frames,
    stub,
    dataDir,
    aPublic: { signing: aIdentity.signingPublicJwk, encryption: aIdentity.publicJwk },
    aPrivate: { signing: aIdentity.signingPrivateJwk, encryption: aIdentity.privateJwk },
    bKeys,
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
/* REQUEST_IDENTITIES: forwarded, then filtered to the grant set       */
/* ------------------------------------------------------------------ */

test("a REQUEST_IDENTITIES (13) from pinned B gets an IDENTITIES_ANSWER filtered to the grant fingerprints, and the session's second request rides the recorded nA", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const req1 = await sealRequest(f, { agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]), seq: 0, nB });
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
    expect(answer.type).toBe(SSH2_AGENT_IDENTITIES_ANSWER);
    expect(answer.count).toBe(1); // the stub roster had 2; only the granted fingerprint survives
    expect(answer.comments).toEqual(["granted key"]);
    expect(f.stub.received.length).toBe(1); // the agent saw exactly one request
    expect(f.stub.received[0]).toEqual(Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]));

    // The second request carries A's recorded nonce; A's expect binds it onward.
    const req2 = await sealRequest(f, { agentBytes: buildSignRequest(KEY_IN), seq: 1, nB, nA: reply1.nA });
    f.relay.onInboundRelayFrame(req2);
    await waitUntil(() => f.frames.length === 2, "the second A2B reply frame");
    const reply2 = await decodeA2B(f, f.frames[1], { nB, nA: reply1.nA });
    expect(f.frames[1].seq).toBe(1); // transport seq advanced
    expect(reply2.seq).toBe(1); // signed anti-replay seq advanced
    expect(reply2.nA).toBe(reply1.nA); // every A2B carries the SAME nA (Task-6 handoff)
    expect(reply2.agentBytes).toEqual(
      Buffer.concat([Buffer.from([SSH2_AGENT_SIGN_RESPONSE]), sshStr(Buffer.from("SIG"))]),
    );
    expect(f.stub.received.length).toBe(2);
    expect(f.stub.received[1]).toEqual(buildSignRequest(KEY_IN));
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* SIGN_REQUEST: in-set forwarded, out-of-set refused before the agent */
/* ------------------------------------------------------------------ */

test("a SIGN_REQUEST (15) for an OUT-of-set blob is refused with SSH2_AGENT_FAILURE and never forwarded to A's agent", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: buildSignRequest(KEY_OUT), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "a refusal reply frame");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([SSH2_AGENT_FAILURE]);
    await sleep(30);
    expect(f.stub.received.length).toBe(0); // the stub agent never saw it (§5.4: refused at the responder)
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* method allow-list: default-deny on everything else                  */
/* ------------------------------------------------------------------ */

test("disallowed request types (ADD 17, REMOVE 18, REMOVE_ALL 19, LOCK 22, UNLOCK 23, EXTENSION 27, SSH1 1) are refused and never forwarded", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const disallowed = [
      SSH2_AGENTC_ADD_IDENTITY,
      SSH2_AGENTC_REMOVE_IDENTITY,
      SSH2_AGENTC_REMOVE_ALL_IDENTITIES,
      SSH2_AGENTC_LOCK,
      SSH2_AGENTC_UNLOCK,
      SSH2_AGENTC_EXTENSION,
      SSH1_AGENTC_REQUEST_RSA_IDENTITIES,
    ];
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
      expect([...reply.agentBytes]).toEqual([SSH2_AGENT_FAILURE]);
      expect(f.frames[i].seq).toBe(i);
      nA = reply.nA; // later requests must carry the recorded nonce onward (real B's state)
    }
    await sleep(30);
    expect(f.stub.received.length).toBe(0); // nothing reached A's agent
  } finally {
    await f.cleanup();
  }
});

test("a malformed SIGN_REQUEST (truncated wire) is refused and not forwarded", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const truncated = Buffer.concat([Buffer.from([SSH2_AGENTC_SIGN_REQUEST]), sshStr(KEY_IN).subarray(0, 2)]);
    const req = await sealRequest(f, { agentBytes: truncated, seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "a refusal reply frame");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([SSH2_AGENT_FAILURE]);
    await sleep(30);
    expect(f.stub.received.length).toBe(0);
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the empty grant: serve nothing, never the full list                 */
/* ------------------------------------------------------------------ */

test("a grant naming no fingerprint yields an empty (count 0) IDENTITIES_ANSWER, never the roster", async () => {
  const f = await openFixture({ fingerprints: [] });
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the filtered reply frame");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    const answer = parseAnswer(reply.agentBytes);
    expect(answer.type).toBe(SSH2_AGENT_IDENTITIES_ANSWER);
    expect(answer.count).toBe(0);
    expect(reply.agentBytes.length).toBe(5); // type + zero count, nothing else
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
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 0,
      nB: newNonce(),
      signerPrivateJwk: evil.privateJwk,
    });
    f.relay.onInboundRelayFrame(req);
    await sleep(50);
    expect(f.frames.length).toBe(0);
    expect(f.stub.received.length).toBe(0);
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
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 0,
      nB,
      relaySessionId: "relay-EVIL",
    });
    f.relay.onInboundRelayFrame(wrongSession);
    await sleep(50);
    expect(f.frames.length).toBe(0);

    // Land the genuine first request so nB is recorded...
    const good = await sealRequest(f, { agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]), seq: 0, nB });
    f.relay.onInboundRelayFrame(good);
    await waitUntil(() => f.frames.length === 1, "the genuine reply");
    const first = await decodeA2B(f, f.frames[0], { nB });

    // ...then a second-seq request carrying a nonce this session never saw.
    const foreignNonce = await sealRequest(f, {
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 1,
      nB: newNonce(),
      nA: first.nA,
    });
    f.relay.onInboundRelayFrame(foreignNonce);
    await sleep(50);
    expect(f.frames.length).toBe(1); // no reply to the foreign nonce
    expect(f.stub.received.length).toBe(1); // and nothing further reached the agent
  } finally {
    await f.cleanup();
  }
});

test("a replayed or non-increasing-seq request is refused: no reply frame, nothing forwarded; the session continues", async () => {
  const f = await openFixture();
  try {
    const nB = newNonce();
    const good = await sealRequest(f, { agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]), seq: 0, nB });
    f.relay.onInboundRelayFrame(good);
    await waitUntil(() => f.frames.length === 1, "the first genuine reply");
    const first = await decodeA2B(f, f.frames[0], { nB });

    // Byte-identical resend of the first frame (the plane can resend anything).
    f.relay.onInboundRelayFrame(good);
    // A freshly signed request that rewinds the seq (the signature binds seq).
    const rewind = await sealRequest(f, {
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 0,
      nB,
      nA: first.nA,
    });
    f.relay.onInboundRelayFrame(rewind);
    await sleep(50);
    expect(f.frames.length).toBe(1);
    expect(f.stub.received.length).toBe(1);

    // The session still works after refusals: seq 1 advances.
    const next = await sealRequest(f, {
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 1,
      nB,
      nA: first.nA,
    });
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
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 0,
      nB,
      ref: "r-EVIL",
    });
    f.relay.onInboundRelayFrame(foreignRef);
    // The wrong direction for A's side (B's own echo posture).
    const echo = await sealRequest(f, {
      agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]),
      seq: 0,
      nB,
      direction: "A2B",
    });
    f.relay.onInboundRelayFrame(echo);
    await sleep(50);
    expect(f.frames.length).toBe(0);
    expect(f.stub.received.length).toBe(0);
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
      },
      sendRelayFrame: () => {},
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
    const req = await sealRequest(f, { agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req); // the registry: unknown ref now, dropped
    await sleep(30);
    expect(f.frames.length).toBe(0);
    expect(f.stub.received.length).toBe(0);
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the live agent socket seam                                          */
/* ------------------------------------------------------------------ */

test("liveAgentSocketPath honors only an absolute SSH_AUTH_SOCK (the ssh-resolve rule)", () => {
  expect(liveAgentSocketPath({ SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock" })).toBe("/run/user/1000/ssh-agent.sock");
  expect(liveAgentSocketPath({})).toBeNull();
  expect(liveAgentSocketPath({ SSH_AUTH_SOCK: "" })).toBeNull();
  expect(liveAgentSocketPath({ SSH_AUTH_SOCK: "relative/path.sock" })).toBeNull();
});

test("with no live agent socket the responder answers SSH2_AGENT_FAILURE and touches nothing", async () => {
  const f = await openFixture({}, { resolveAgentSocket: () => null });
  try {
    const nB = newNonce();
    const req = await sealRequest(f, { agentBytes: Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]), seq: 0, nB });
    f.relay.onInboundRelayFrame(req);
    await waitUntil(() => f.frames.length === 1, "the no-agent refusal reply");
    const reply = await decodeA2B(f, f.frames[0], { nB });
    expect([...reply.agentBytes]).toEqual([SSH2_AGENT_FAILURE]);
    expect(f.stub.received.length).toBe(0); // the stub socket was never connected
  } finally {
    await f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the filtering/parser helpers, pinned directly                       */
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
      seal: mcpSeal,
      open: mcpOpen,
      sendRelayFrame: () => {},
    }),
  ).toThrow(/relay responder: pinned peer key rejected/);
});

test("fingerprintAgentBlob spells SHA256 over the wire blob in the grant grammar's base64url form", () => {
  const s = fingerprintAgentBlob(Buffer.from("hello"));
  expect(s).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
  expect(s).toBe(fp(Buffer.from("hello")));
});

test("filterIdentitiesAnswer keeps only granted entries (count fixed, bytes preserved) and refuses malformed answers", () => {
  const allowed = new Set([fp(KEY_OUT)]); // grant the SECOND entry: order must not matter
  const filtered = filterIdentitiesAnswer(buildIdentitiesAnswer(ROSTER), allowed);
  const answer = parseAnswer(filtered);
  expect(answer.count).toBe(1);
  expect(answer.comments).toEqual(["ungranted key"]);
  // The kept entry's wire bytes survive byte-identical: type + count + str(blob) + str(comment).
  expect(filtered).toEqual(
    Buffer.concat([Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]), be32(1), sshStr(KEY_OUT), sshStr("ungranted key")]),
  );
  expect(filterIdentitiesAnswer(buildIdentitiesAnswer([]), new Set()).length).toBe(5);
  // Malformed: declared entries the buffer does not carry, and a wrong type byte.
  const truncated = buildIdentitiesAnswer(ROSTER).subarray(0, 20);
  expect(() => filterIdentitiesAnswer(truncated, new Set())).toThrow();
  expect(() => filterIdentitiesAnswer(Buffer.from([SSH2_AGENT_SIGN_RESPONSE, 0, 0, 0, 0]), new Set())).toThrow();
});
