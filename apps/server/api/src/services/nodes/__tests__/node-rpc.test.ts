import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  type CommandClaims,
  type ControlKeyPair,
  JtiLru,
  NODE_CMD_TTL_SEC,
  parseNodeEvent,
  SeqTracker,
  verifyCommand,
} from "@internal/subshell-protocol";
import {
  createClientSessionWithEphemeral,
  createServerSession,
  generateLinkKeyPair,
  type LinkSession,
} from "@internal/subshell-protocol/node-link-crypto";
import { loadControlKeys } from "../control-keys.js";
import { attachConnection, type NodeSocket, resetNodeRegistryForTests } from "../node-registry.js";
import { failConnPendings, type NodeResultEvent, NodeRpcError, resolveResult, sendCommand } from "../node-rpc.js";

/** Fake agent socket: records every wire frame we send it (text OR binary). */
interface FakeSocket extends NodeSocket {
  sent: Array<string | Buffer>;
  closed: { code?: number; reason?: string }[];
}

function fakeSocket(): FakeSocket {
  return {
    sent: [],
    closed: [],
    send(data: string | Buffer) {
      this.sent.push(data);
      return data.length;
    },
    close() {},
  };
}

/** Poll `cond` until true (the send path awaits signing, so frames land asynchronously). */
async function waitFor(cond: () => boolean, what = "condition", budgetMs = 2000): Promise<void> {
  for (let waited = 0; ; waited += 5) {
    if (cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The JWS of PLAINTEXT wire frame `i` (frames are `{ jws }`). A binary frame
 * here is the sealed path reaching a test that expects the legacy one — say
 * so rather than JSON-parsing bytes into a confusing failure.
 */
function jwsOf(sent: Array<string | Buffer>, i: number): string {
  const raw = sent[i];
  if (typeof raw !== "string") throw new Error(`frame ${i} is binary, not the plaintext { jws } envelope`);
  const frame = JSON.parse(raw) as { jws?: string };
  if (typeof frame.jws !== "string") throw new Error(`frame ${i} is not { jws }`);
  return frame.jws;
}

/** Decode a JWS payload segment WITHOUT verifying — for asserting plain claims like `aud`. */
function decodeClaims(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Unwrap a sent envelope with the REAL verifier (signature + claims) and return its claims. */
async function unwrap(
  jws: string,
  nodeId: string,
  publicJwk: ControlKeyPair["publicJwk"],
  lru: JtiLru,
  tracker: SeqTracker,
) {
  const out = await verifyCommand(jws, publicJwk, { nodeId, jtiLru: lru, seqTracker: tracker });
  if (!out.ok) throw new Error(`envelope rejected by verifyCommand: ${out.reason}`);
  return out.claims;
}

/**
 * Both sides of a REAL link, derived through Task 1's crypto (no mock): the
 * server session seals what `sendCommand` puts on the wire, the client
 * session opens it. Mocking `sealFrame` would let ANY bytes pass these
 * assertions — the point is that the wire carries this session's actual
 * secretstream ciphertext, order included.
 */
async function linkPair(): Promise<{ server: LinkSession; client: LinkSession }> {
  const serverStatic = await generateLinkKeyPair();
  const ephemeral = await generateLinkKeyPair();
  const server = await createServerSession({
    serverStatic,
    clientEphemeralPublicKey: ephemeral.publicKey,
  });
  const { session: client } = await createClientSessionWithEphemeral({
    serverStaticPublicKey: serverStatic.publicKey,
    ephemeral,
  });
  return { server, client };
}

/** Run a promise's rejection through NodeRpcError-shaped assertions. */
async function rejection(promise: Promise<unknown>): Promise<NodeRpcError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NodeRpcError);
  return err as NodeRpcError;
}

describe("node rpc (spec 2026-08-31 §4/§5.3)", () => {
  let publicJwk: ControlKeyPair["publicJwk"];

  beforeAll(async () => {
    publicJwk = (await loadControlKeys()).publicJwk;
  });

  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("rejects `offline` when the node has no live connection", async () => {
    const err = await rejection(sendCommand("ghost", { type: "ping" }, { timeoutMs: 1000 }));
    expect(err.code).toBe("offline");
    expect(err.nodeId).toBe("ghost");
  });

  it("sends a signed envelope and resolves with result.data, correlated by jti", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);

    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 1, "first frame");

    const jws = jwsOf(fake.sent, 0);
    const claims = await unwrap(jws, "n1", publicJwk, new JtiLru(), new SeqTracker());
    expect(claims.seq).toBe(1);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.cmd).toEqual({ type: "ping" });

    // Plain (decoded) claims pin the envelope shape the agent expects.
    const payload = decodeClaims(jws);
    expect(payload.aud).toBe("node:n1");
    expect(payload.iss).toBe("subshell-control");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(NODE_CMD_TTL_SEC);

    // Reply as the WS handler would: parsed event → resolveResult(conn, ev).
    const ev = parseNodeEvent(JSON.stringify({ type: "result", ref: claims.jti, ok: true, data: { pong: true } }));
    if (ev?.type !== "result") throw new Error("reply should parse as a result event");
    expect(resolveResult(conn, ev)).toBe(true);
    expect(await p).toEqual({ pong: true });
  });

  it("resolveResult is CONNECTION-scoped: a foreign conn cannot settle another node's jti", async () => {
    const fakeA = fakeSocket();
    const connA = attachConnection("nA", fakeA);
    const fakeB = fakeSocket();
    const connB = attachConnection("nB", fakeB);

    const p = sendCommand("nA", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fakeA.sent.length === 1, "frame on A");
    const claims = await unwrap(jwsOf(fakeA.sent, 0), "nA", publicJwk, new JtiLru(), new SeqTracker());
    const ev = { type: "result", ref: claims.jti, ok: true, data: "stolen" } satisfies NodeResultEvent;

    // Even holding A's jti (leaked/observed), settling must go through A's
    // connection — B's socket refuses, and A's pending survives the attempt.
    expect(resolveResult(connB, ev)).toBe(false);
    expect(connA.pending.size).toBe(1);

    // The honest path still works: the SAME connection the command left on.
    expect(resolveResult(connA, ev)).toBe(true);
    expect(await p).toBe("stolen");
  });

  it("resolves with `undefined` data when the result omits it", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 1, "frame");

    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    resolveResult(conn, { type: "result", ref: claims.jti, ok: true } satisfies NodeResultEvent);
    expect(await p).toBeUndefined();
  });

  it("rejects `unsupported` when the node answers error=unsupported", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 1, "frame");

    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    const ev = parseNodeEvent({ type: "result", ref: claims.jti, ok: false, error: "unsupported" });
    if (ev?.type !== "result") throw new Error("reply should parse");
    resolveResult(conn, ev);

    const err = await rejection(p);
    expect(err.code).toBe("unsupported");
  });

  it("rejects `failed` carrying the node's error message for any other ok:false", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 1, "frame");

    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    resolveResult(conn, {
      type: "result",
      ref: claims.jti,
      ok: false,
      error: "no such file",
    } satisfies NodeResultEvent);

    const err = await rejection(p);
    expect(err.code).toBe("failed");
    expect(err.message).toContain("no such file");
  });

  it("rejects `timeout` on the deadline and drops the pending entry", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 30 });
    await waitFor(() => fake.sent.length === 1, "frame");
    expect(conn.pending.size).toBe(1);

    const err = await rejection(p);
    expect(err.code).toBe("timeout");
    expect(conn.pending.size).toBe(0); // pending entry dropped

    // A late reply for the abandoned jti matches nothing.
    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    expect(resolveResult(conn, { type: "result", ref: claims.jti, ok: true } satisfies NodeResultEvent)).toBe(false);
  });

  it("a concurrent burst keeps seq strictly increasing in SENT order, each promise on its own jti", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);

    // Distinct cmd payloads identify each call even once they interleave.
    const promises = [0, 1, 2, 3, 4].map((i) =>
      sendCommand("n1", { type: "stat_dir", path: `/p${i}` }, { timeoutMs: 5000 }),
    );
    await waitFor(() => fake.sent.length === 5, "all five frames");

    // One shared LRU + tracker: verifyCommand itself enforces no-replay and
    // strictly ascending seq ACROSS the unwraps — i.e. in wire order.
    const lru = new JtiLru();
    const tracker = new SeqTracker();
    const claims: CommandClaims[] = [];
    for (let i = 0; i < 5; i++) {
      claims.push(await unwrap(jwsOf(fake.sent, i), "n1", publicJwk, lru, tracker));
    }

    expect(claims.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(claims.map((c) => (c.cmd as { path: string }).path)).toEqual(["/p0", "/p1", "/p2", "/p3", "/p4"]);

    // Answer every command, echoing its jti; each promise must resolve with ITS jti.
    for (const c of claims) {
      resolveResult(conn, { type: "result", ref: c.jti, ok: true, data: { jti: c.jti } });
    }
    const results = (await Promise.all(promises)) as { jti: string }[];
    results.forEach((r, i) => {
      expect(r.jti).toBe(claims[i].jti);
    });
  });

  it("rejects `failed` when the socket send itself throws", async () => {
    const broken: NodeSocket = {
      send: () => {
        throw new Error("socket is closed");
      },
      close: () => {},
    };
    const conn = attachConnection("n1", broken);
    const err = await rejection(sendCommand("n1", { type: "ping" }, { timeoutMs: 1000 }));
    expect(err.code).toBe("failed");
    expect(conn.pending.size).toBe(0);
  });

  it("failConnPendings drains ONLY the given connection — the superseded-socket close path", async () => {
    const oldFake = fakeSocket();
    const oldConn = attachConnection("n1", oldFake);
    const p1 = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => oldFake.sent.length === 1, "old frame");

    // Supersede: the registry now maps the FRESH socket, but the old socket's
    // close event has not fired yet (its pending must survive until it does).
    const fresh = fakeSocket();
    const freshConn = attachConnection("n1", fresh);
    const p2 = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fresh.sent.length === 1, "fresh frame");

    expect(failConnPendings(oldConn)).toBe(1); // targeted: only the old conn
    expect((await rejection(p1)).code).toBe("offline");
    expect(freshConn.pending.size).toBe(1); // the mapped connection is untouched
    expect(oldConn.pending.size).toBe(0);

    expect(failConnPendings(freshConn)).toBe(1);
    expect((await rejection(p2)).code).toBe("offline");
  });

  it("failConnPendings honors a custom code/message and clears the map", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p1 = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    const p2 = sendCommand("n1", { type: "inventory" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 2, "two frames");
    expect(conn.pending.size).toBe(2);

    expect(failConnPendings(conn, "failed", "node went away")).toBe(2);
    const err = await rejection(p1);
    expect(err.code).toBe("failed");
    expect(err.message).toBe("node went away");
    expect((await rejection(p2)).code).toBe("failed");
    expect(conn.pending.size).toBe(0);
  });

  /* ---------------- encrypted-link send seam (task 6) ---------------- */

  it("a connection with a link sends a Buffer whose openFrame round-trips to the { jws } envelope", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const { server, client } = await linkPair();
    conn.link = server;

    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 1, "sealed frame");

    // THE Buffer-view fact: Elysia's `ElysiaWS.send` JSON-stringifies a bare
    // Uint8Array into a TEXT frame (the bug that bit /ws/live), so the send
    // site must hand the socket a Buffer VIEW over the sealed bytes. The fake
    // records exactly what it is given — this is the wire-visible half.
    const wire = fake.sent[0];
    expect(Buffer.isBuffer(wire)).toBe(true);
    if (!Buffer.isBuffer(wire)) throw new Error("sealed frame must travel as a Buffer, not a string");

    const plaintext = client.openFrame(wire);
    expect(plaintext).not.toBeNull(); // null here = not this session's ciphertext
    const envelope = JSON.parse(plaintext as string) as { jws?: string };
    expect(typeof envelope.jws).toBe("string");

    // The decrypted envelope is the REAL one: the plain text path's own
    // verifier accepts it, with this node's claims.
    const claims = await unwrap(envelope.jws as string, "n1", publicJwk, new JtiLru(), new SeqTracker());
    expect(claims.seq).toBe(1);
    expect(claims.cmd).toEqual({ type: "ping" });

    resolveResult(conn, { type: "result", ref: claims.jti, ok: true, data: "pong" } satisfies NodeResultEvent);
    expect(await p).toBe("pong");
  });

  it("sealed frames on one link are order-dependent ciphertext, and both carry verifiable claims", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const { server, client } = await linkPair();
    conn.link = server;

    const p0 = sendCommand("n1", { type: "stat_dir", path: "/a" }, { timeoutMs: 5000 });
    const p1 = sendCommand("n1", { type: "stat_dir", path: "/b" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 2, "both sealed frames");
    expect(fake.sent.every((f) => Buffer.isBuffer(f))).toBe(true);

    // The secretstream ratchets: the client opens in SEND ORDER and each
    // decryption yields a verifiable envelope whose seq is the wire position.
    const lru = new JtiLru();
    const tracker = new SeqTracker();
    const first = client.openFrame(fake.sent[0] as Buffer);
    expect(first).not.toBeNull();
    const second = client.openFrame(fake.sent[1] as Buffer);
    expect(second).not.toBeNull();
    const claims0 = await unwrap((JSON.parse(first as string) as { jws: string }).jws, "n1", publicJwk, lru, tracker);
    const claims1 = await unwrap((JSON.parse(second as string) as { jws: string }).jws, "n1", publicJwk, lru, tracker);
    expect([claims0.seq, claims1.seq]).toEqual([1, 2]);
    expect([(claims0.cmd as { path: string }).path, (claims1.cmd as { path: string }).path]).toEqual(["/a", "/b"]);

    resolveResult(conn, { type: "result", ref: claims0.jti, ok: true, data: "/a" });
    resolveResult(conn, { type: "result", ref: claims1.jti, ok: true, data: "/b" });
    expect(await Promise.all([p0, p1])).toEqual(["/a", "/b"]);

    // Out-of-order proof on a FRESH pair of sessions (this pair's pull state
    // has already ratcheted): opening frame 2 first authenticates nothing —
    // the bytes are genuinely this stream's, not a re-marshalable payload.
    const { server: serverB, client: clientB } = await linkPair();
    const _sealed1 = serverB.sealFrame(JSON.stringify({ jws: "one" }));
    const sealed2 = serverB.sealFrame(JSON.stringify({ jws: "two" }));
    expect(clientB.openFrame(sealed2)).toBeNull();
  });

  it("a connection WITHOUT a link still sends the plain text envelope, byte-for-byte unchanged", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);

    const p = sendCommand("n1", { type: "ping" }, { timeoutMs: 5000 });
    await waitFor(() => fake.sent.length === 1, "plaintext frame");

    // The held/legacy path is this branch's unchanged behavior — what the
    // socket receives is exactly the string it always received.
    expect(typeof fake.sent[0]).toBe("string");
    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    expect(claims.cmd).toEqual({ type: "ping" });
    expect(fake.closed).toEqual([]);

    resolveResult(conn, { type: "result", ref: claims.jti, ok: true, data: "pong" } satisfies NodeResultEvent);
    expect(await p).toBe("pong");
  });
});
