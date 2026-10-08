import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as mcpOpen, seal as mcpSeal } from "@internal/mcp-core";
import {
  base64UrlNoPad,
  newNonce,
  openRelayEnvelope,
  parseRelayFrame,
  type RelayFrame,
  SSH_RELAY_FRAME_MAX_BYTES,
  sealRelayEnvelope,
  verifyRelayEnvelope,
} from "@internal/subshell-protocol";
import { exportJWK, generateKeyPair } from "jose";
import { RelaySessions } from "../commands/ssh-relay.js";
import { type AgentProxyHandle, buildAgentSocketPath, startAgentProxy } from "../relay-proxy.js";

/**
 * The B-side ssh-agent proxy (spec 2026-10-08 §5.2/§5.6) over the Task-5 codec.
 * seal/open are the REAL mcp-core pair (the production pair, injected as the
 * codec's own doctrine demands), and the A-side test keys are generated the
 * same way the protocol tests do it, so the envelope the proxy produces and
 * consumes is the shipped wire shape end to end.
 */

/** The ssh-agent wire type bytes (OpenSSH `agent-proto.h`). */
const SSH2_AGENTC_REQUEST_IDENTITIES = 17;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const SSH2_AGENT_IDENTITIES = 18;

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

// One cast of keys for the whole file: generation is the slow part, and the
// pins are per-proxy inputs anyway. A = key home, B = this machine.
const aKeysReady: Promise<{ signing: JwkPair; encryption: JwkPair }> = Promise.all([es256Pair(), ecdhPair()]).then(
  ([signing, encryption]) => ({ signing, encryption }),
);
const bKeysReady: Promise<{ signing: JwkPair; encryption: JwkPair }> = Promise.all([es256Pair(), ecdhPair()]).then(
  ([signing, encryption]) => ({ signing, encryption }),
);
/** An ES256 pair nobody pinned: replies signed with it are forgeries. */
const evilKeysReady: Promise<JwkPair> = es256Pair();

/** The one frame grammar the tests accept: 4-byte BE length + payload. */
function agentFrame(payload: number[]): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
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

function connectSocket(socketPath: string): Socket {
  const conn = createConnection({ path: socketPath });
  conn.on("error", () => {
    /* the tests read failures through data/close events, not error throws */
  });
  return conn;
}

/** Collect everything a socket received, and whether it was closed. */
function spy(conn: Socket): { chunks: Buffer[]; closed: () => boolean } {
  const chunks: Buffer[] = [];
  let closed = false;
  conn.on("data", (d) => chunks.push(Buffer.from(d)));
  conn.on("close", () => {
    closed = true;
  });
  return { chunks, closed: () => closed };
}

interface ProxyFixture {
  proxy: AgentProxyHandle;
  frames: RelayFrame[];
  dataDir: string;
  relayId: string;
  ref: string;
  bNodeId: string;
  cleanup(): void;
}

async function startFixture(paneId = "pane-1"): Promise<ProxyFixture> {
  const [aKeys, bKeys] = await Promise.all([aKeysReady, bKeysReady]);
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-relay-proxy-"));
  const frames: RelayFrame[] = [];
  const proxy = await startAgentProxy({
    dataDir,
    paneId,
    relayId: "relay-1",
    ref: "r-1",
    peerNodeId: "a-node",
    selfNodeId: "b-node",
    peerSigningJwk: aKeys.signing.publicJwk,
    peerEncryptionJwk: aKeys.encryption.publicJwk,
    ownEncryptionPublicJwk: bKeys.encryption.publicJwk,
    ownEncryptionPrivateJwk: bKeys.encryption.privateJwk,
    ownSigningPrivateJwk: bKeys.signing.privateJwk,
    seal: mcpSeal,
    open: mcpOpen,
    sendRelayFrame: (frame) => {
      frames.push(frame);
    },
  });
  return {
    proxy,
    frames,
    dataDir,
    relayId: "relay-1",
    ref: "r-1",
    bNodeId: "b-node",
    cleanup: () => proxy.close(),
  };
}

/**
 * Open one outbound B2A frame's blob AS A (the seal is addressed to A's
 * encryption key), and verify its signature against B's public signing key:
 * the mirror of the checklist the proxy runs on replies.
 */
async function openAndVerifyB2A(
  fixture: ProxyFixture,
  frame: RelayFrame,
): Promise<{ agentBytes: Buffer; nB: string; nA?: string; seq: number }> {
  const [aKeys, bKeys] = await Promise.all([aKeysReady, bKeysReady]);
  const opened = await openRelayEnvelope({
    blob: frame.blob,
    own: {
      principalId: "node:a-node",
      publicJwk: aKeys.encryption.publicJwk,
      privateJwk: aKeys.encryption.privateJwk,
    },
    open: mcpOpen,
    expect: { ref: frame.ref, direction: frame.direction },
  });
  const message = await verifyRelayEnvelope({
    jws: opened.jws,
    publicJwk: JSON.parse(bKeys.signing.publicJwk) as JsonWebKey,
    expect: { routingRef: fixture.ref, direction: "B2A", seq: opened.seq },
  });
  return {
    agentBytes: Buffer.from(message.agentBytesB64, "base64url"),
    nB: message.nB ?? "",
    nA: message.nA,
    seq: opened.seq,
  };
}

/** Seal one A2B reply exactly as A's responder will (Task 7): A's signing key, B's pinned encryption key. */
async function sealReply(
  fixture: ProxyFixture,
  opts: {
    seq: number;
    nB: string;
    nA?: string;
    agentBytes: number[];
    signerPrivateJwk?: string;
    relaySessionId?: string;
  },
): Promise<RelayFrame> {
  const [aKeys, bKeys] = await Promise.all([aKeysReady, bKeysReady]);
  const blob = await sealRelayEnvelope({
    message: {
      relaySessionId: opts.relaySessionId ?? fixture.relayId,
      routingRef: fixture.ref,
      direction: "A2B",
      seq: opts.seq,
      nB: opts.nB,
      ...(opts.nA === undefined ? {} : { nA: opts.nA }),
      agentBytesB64: base64UrlNoPad(new Uint8Array(opts.agentBytes)),
    },
    privateJwk: JSON.parse(opts.signerPrivateJwk ?? aKeys.signing.privateJwk) as JsonWebKey,
    recipient: { principalId: `node:${fixture.bNodeId}`, publicJwk: bKeys.encryption.publicJwk },
    seal: mcpSeal,
  });
  return { type: "relay", ref: fixture.ref, seq: opts.seq, direction: "A2B", blob };
}

/* ------------------------------------------------------------------ */
/* outbound: each agent request becomes exactly one sealed B2A frame   */
/* ------------------------------------------------------------------ */

test("a REQUEST_IDENTITIES on the socket emits exactly one B2A relay frame, seq 0, carrying the agent bytes", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const w = await new Promise<void>((res, rej) => {
      conn.on("connect", () => res());
      conn.on("error", rej);
    });
    void w;
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "one outbound relay frame");
    await sleep(30);
    expect(f.frames.length).toBe(1); // exactly one

    const frame = f.frames[0];
    expect(parseRelayFrame(JSON.stringify(frame))).not.toBeNull(); // it is wire-legal
    expect(frame.type).toBe("relay");
    expect(frame.ref).toBe("r-1");
    expect(frame.direction).toBe("B2A");
    expect(frame.seq).toBe(0); // the transport slot

    const opened = await openAndVerifyB2A(f, frame);
    expect(opened.seq).toBe(0); // the SIGNED anti-replay seq agrees for the first request
    expect(opened.agentBytes).toEqual(Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]));
    expect(opened.nB).toMatch(/^[A-Za-z0-9_-]{22}$/); // a 128-bit base64url endpoint nonce
    expect(opened.nA).toBeUndefined(); // B speaks first; nA has not been minted yet
    conn.destroy();
  } finally {
    f.cleanup();
  }
});

test("a second request gets seq 1 and carries the recorded nA onward", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));

    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "first request frame");
    const first = await openAndVerifyB2A(f, f.frames[0]);

    const nA = newNonce();
    const reply = await sealReply(f, { seq: 0, nB: first.nB, nA, agentBytes: [SSH2_AGENT_IDENTITIES, 0, 0, 0, 0] });
    f.proxy.deliverInboundRelayFrame(reply);
    await waitUntil(() => spyC.chunks.length === 1, "reply bytes written back");

    conn.write(agentFrame([SSH2_AGENTC_SIGN_REQUEST, 0, 1, 2, 3]));
    await waitUntil(() => f.frames.length === 2, "second request frame");
    const second = await openAndVerifyB2A(f, f.frames[1]);
    expect(f.frames[1].seq).toBe(1); // transport seq advanced
    expect(second.seq).toBe(1); // signed anti-replay seq advanced
    expect(second.nB).toBe(first.nB); // B keeps its own nonce
    expect(second.nA).toBe(nA); // and signs A's onward (§5.6: recorded peer value)
    expect(second.agentBytes).toEqual(Buffer.from([SSH2_AGENTC_SIGN_REQUEST, 0, 1, 2, 3]));
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* inbound: a verified reply is written back; a refused one never is   */
/* ------------------------------------------------------------------ */

test("a correctly sealed+signed A reply (stub A keypair pinned) writes the agent bytes back on the socket", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "request frame out");
    const first = await openAndVerifyB2A(f, f.frames[0]);

    const replyBytes = [SSH2_AGENT_IDENTITIES, 0, 0, 0, 2, 0, 0, 0, 1, 65];
    const reply = await sealReply(f, { seq: 0, nB: first.nB, nA: newNonce(), agentBytes: replyBytes });
    f.proxy.deliverInboundRelayFrame(reply);
    await waitUntil(() => spyC.chunks.length >= 1, "reply written back");

    const written = Buffer.concat(spyC.chunks);
    const len = written.readUInt32BE(0);
    expect(len).toBe(replyBytes.length);
    expect(written.subarray(4)).toEqual(Buffer.from(replyBytes));
  } finally {
    f.cleanup();
  }
});

test("a reply signed by the WRONG key is refused: nothing written, the pending connection fails", async () => {
  const f = await startFixture();
  const evil = await evilKeysReady;
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "request frame out");
    const first = await openAndVerifyB2A(f, f.frames[0]);

    const forged = await sealReply(f, {
      seq: 0,
      nB: first.nB,
      nA: newNonce(),
      agentBytes: [SSH2_AGENT_IDENTITIES],
      signerPrivateJwk: evil.privateJwk, // not the pinned key: an origin failure
    });
    f.proxy.deliverInboundRelayFrame(forged);
    await waitUntil(() => spyC.closed(), "connection failed");
    expect(spyC.chunks.length).toBe(0); // NEVER a forged reply on the wire to ssh
  } finally {
    f.cleanup();
  }
});

test("a reply with a mismatched relay-session id or nB nonce is refused and not written", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "request frame out");
    const first = await openAndVerifyB2A(f, f.frames[0]);

    // Cross-session replay: right keys, another session's id.
    const wrongSession = await sealReply(f, {
      seq: 0,
      nB: first.nB,
      nA: newNonce(),
      agentBytes: [SSH2_AGENT_IDENTITIES],
      relaySessionId: "relay-OTHER",
    });
    f.proxy.deliverInboundRelayFrame(wrongSession);
    await waitUntil(() => spyC.closed(), "session-id mismatch fails the pending connection");
    expect(spyC.chunks.length).toBe(0);

    // Foreign nonce: this machine never minted it.
    const conn2 = connectSocket(f.proxy.socketPath);
    const spy2 = spy(conn2);
    await new Promise<void>((res) => conn2.on("connect", () => res()));
    conn2.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 2, "second request frame out");
    const wrongNonce = await sealReply(f, {
      seq: 0,
      nB: newNonce(),
      nA: newNonce(),
      agentBytes: [SSH2_AGENT_IDENTITIES],
    });
    f.proxy.deliverInboundRelayFrame(wrongNonce);
    await waitUntil(() => spy2.closed(), "nonce mismatch fails the pending connection");
    expect(spy2.chunks.length).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("a repeated seq is refused by the SeqGate and not written; a valid next-seq reply still is", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "request frame out");
    const first = await openAndVerifyB2A(f, f.frames[0]);

    const nA = newNonce();
    const good = await sealReply(f, { seq: 0, nB: first.nB, nA, agentBytes: [1, 2, 3] });
    f.proxy.deliverInboundRelayFrame(good);
    await waitUntil(() => spyC.chunks.length === 1, "first reply written");

    // The plane can resend ANY envelope it routed (§5.6): a byte-identical
    // resend and a rewind are both refused, and a refusal costs nothing on
    // the live stream - the connection stays open for the next request.
    f.proxy.deliverInboundRelayFrame(good); // resend, seq 0 again
    const rewind = await sealReply(f, { seq: 0, nB: first.nB, nA, agentBytes: [9, 9, 9] });
    f.proxy.deliverInboundRelayFrame(rewind);
    const lower = await sealReply(f, { seq: 0, nB: first.nB, nA, agentBytes: [8, 8, 8] });
    f.proxy.deliverInboundRelayFrame(lower);
    await sleep(50);
    expect(spyC.chunks.length).toBe(1); // nothing further was written
    expect(spyC.closed()).toBe(false); // a replay refusal is not a connection failure

    // The stream continues: seq 1 over seq 0 is accepted.
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 2, "second request frame out");
    const next = await sealReply(f, { seq: 1, nB: first.nB, nA, agentBytes: [4, 5, 6] });
    f.proxy.deliverInboundRelayFrame(next);
    await waitUntil(() => spyC.chunks.length === 2, "next-seq reply written");
    expect(spyC.chunks[1].subarray(4)).toEqual(Buffer.from([4, 5, 6]));
  } finally {
    f.cleanup();
  }
});

test("an openable but unsigned-sealed blob (plane-crafted noise, wrong recipient slot) is dropped without killing the pending request", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));
    conn.write(agentFrame([SSH2_AGENTC_REQUEST_IDENTITIES]));
    await waitUntil(() => f.frames.length === 1, "request frame out");

    // Not even valid base64-of-a-JWE: the open fails before any trust question.
    f.proxy.deliverInboundRelayFrame({ type: "relay", ref: "r-1", seq: 0, direction: "A2B", blob: "AAAAAAAAAAAAAAAA" });
    await sleep(30);
    expect(spyC.chunks.length).toBe(0);
    expect(spyC.closed()).toBe(false); // noise from the routing plane costs the pane nothing

    // And the session still works: the real reply lands.
    const first = await openAndVerifyB2A(f, f.frames[0]);
    const good = await sealReply(f, { seq: 0, nB: first.nB, nA: newNonce(), agentBytes: [7] });
    f.proxy.deliverInboundRelayFrame(good);
    await waitUntil(() => spyC.chunks.length === 1, "valid reply still written");
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the socket file and its directory                                   */
/* ------------------------------------------------------------------ */

test("the socket lives at <dataDir>/ssh/<paneId>/agent.sock, mode 0600, not in the pane log dir", async () => {
  const f = await startFixture("pane-42");
  try {
    const expected = join(f.dataDir, "ssh", "pane-42", "agent.sock");
    expect(f.proxy.socketPath).toBe(expected);
    expect(buildAgentSocketPath(f.dataDir, "pane-42")).toBe(expected);
    // The M1 pane CONFIG lands in the same dir (spec §5.2 "beside the rendered
    // config"); the pane LOG dir is <dataDir>/subshells - a different tree.
    expect(f.proxy.socketPath).not.toContain(join(f.dataDir, "subshells"));
    const st = statSync(f.proxy.socketPath);
    expect(st.mode & 0o777).toBe(0o600);
    const dir = statSync(join(f.dataDir, "ssh", "pane-42"));
    expect(dir.mode & 0o777).toBe(0o700);
  } finally {
    f.cleanup();
  }
});

test("close() unbinds: the socket file is gone and a fresh connect fails", async () => {
  const f = await startFixture();
  const path = f.proxy.socketPath;
  f.proxy.close();
  await waitUntil(() => {
    try {
      statSync(path);
      return false;
    } catch {
      return true;
    }
  }, "socket file unlinked");
  const conn = createConnection({ path });
  let failed = false;
  conn.on("error", () => {
    failed = true;
  });
  await waitUntil(() => failed, "connect refused after close");
  // Idempotent: a second close must not throw.
  f.proxy.close();
});

test("an over-cap request length prefix fails the connection without emitting a frame", async () => {
  const f = await startFixture();
  try {
    const conn = connectSocket(f.proxy.socketPath);
    const spyC = spy(conn);
    await new Promise<void>((res) => conn.on("connect", () => res()));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(SSH_RELAY_FRAME_MAX_BYTES + 1, 0);
    conn.write(header);
    await waitUntil(() => spyC.closed(), "over-cap request drops the connection");
    expect(f.frames.length).toBe(0);
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* the registry seam the daemon routes into (Task 7 reuses this one)   */
/* ------------------------------------------------------------------ */

test("RelaySessions dispatches by ref to the owning role: registered, unknown, duplicate, throwing", () => {
  const relay = new RelaySessions();
  const seenA: RelayFrame[] = [];
  const seenB: RelayFrame[] = [];
  let closedWith = "";
  const frame = (ref: string): RelayFrame => ({ type: "relay", ref, seq: 0, direction: "A2B", blob: "AAAA" });

  expect(
    relay.register("r-1", {
      onRelayFrame: (f) => seenA.push(f),
      close: (reason) => {
        closedWith = reason;
      },
    }),
  ).toBe(true);
  expect(relay.register("r-1", { onRelayFrame: (f) => seenB.push(f), close: () => {} })).toBe(false); // ref already owned
  expect(
    relay.register("r-2", {
      onRelayFrame: () => {
        throw new Error("handler boom");
      },
      close: () => {},
    }),
  ).toBe(true);

  relay.onInboundRelayFrame(frame("r-1"));
  expect(seenA.length).toBe(1);
  expect(seenB.length).toBe(0);

  relay.onInboundRelayFrame(frame("unknown-ref")); // never throws into the frame chain
  relay.onInboundRelayFrame(frame("r-2")); // a throwing owner is contained, not rethrown

  relay.closeAll("grant-revoked");
  expect(closedWith).toBe("grant-revoked");
  expect(relay.size).toBe(0);
  relay.onInboundRelayFrame(frame("r-1")); // after closeAll nothing routes, nothing throws
  expect(seenA.length).toBe(1);
});
