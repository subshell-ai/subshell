import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  type CommandClaims,
  type ControlKeyPair,
  JtiLru,
  NODE_CMD_TTL_SEC,
  parseNodeEvent,
  SeqTracker,
  verifyCommand,
} from "@internal/session-protocol";
import { loadControlKeys } from "../control-keys.js";
import { attachConnection, getLive, type NodeSocket, resetNodeRegistryForTests } from "../node-registry.js";
import {
  failAllFor,
  failConnPendings,
  type NodeResultEvent,
  NodeRpcError,
  resolveResult,
  sendCommand,
} from "../node-rpc.js";

/** Fake agent socket: records every wire frame we send it. */
interface FakeSocket extends NodeSocket {
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

function fakeSocket(): FakeSocket {
  return {
    sent: [],
    closed: [],
    send(data: string) {
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

/** The JWS of wire frame `i` (frames are `{ jws }`). */
function jwsOf(sent: string[], i: number): string {
  const frame = JSON.parse(sent[i]) as { jws?: string };
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
    const err = await rejection(sendCommand("ghost", { type: "ping" }, 1000));
    expect(err.code).toBe("offline");
    expect(err.nodeId).toBe("ghost");
  });

  it("sends a signed envelope and resolves with result.data, correlated by jti", async () => {
    const fake = fakeSocket();
    attachConnection("n1", fake);

    const p = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => fake.sent.length === 1, "first frame");

    const jws = jwsOf(fake.sent, 0);
    const claims = await unwrap(jws, "n1", publicJwk, new JtiLru(), new SeqTracker());
    expect(claims.seq).toBe(1);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.cmd).toEqual({ type: "ping" });

    // Plain (decoded) claims pin the envelope shape the agent expects.
    const payload = decodeClaims(jws);
    expect(payload.aud).toBe("node:n1");
    expect(payload.iss).toBe("mote-control");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(NODE_CMD_TTL_SEC);

    // Reply as the WS handler would: parsed event → resolveResult.
    const ev = parseNodeEvent(JSON.stringify({ type: "result", ref: claims.jti, ok: true, data: { pong: true } }));
    if (ev?.type !== "result") throw new Error("reply should parse as a result event");
    expect(resolveResult(ev)).toBe(true);
    expect(await p).toEqual({ pong: true });
  });

  it("resolves with `undefined` data when the result omits it", async () => {
    const fake = fakeSocket();
    attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => fake.sent.length === 1, "frame");

    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    resolveResult({ type: "result", ref: claims.jti, ok: true } satisfies NodeResultEvent);
    expect(await p).toBeUndefined();
  });

  it("rejects `unsupported` when the node answers error=unsupported", async () => {
    const fake = fakeSocket();
    attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => fake.sent.length === 1, "frame");

    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    const ev = parseNodeEvent({ type: "result", ref: claims.jti, ok: false, error: "unsupported" });
    if (ev?.type !== "result") throw new Error("reply should parse");
    resolveResult(ev);

    const err = await rejection(p);
    expect(err.code).toBe("unsupported");
  });

  it("rejects `failed` carrying the node's error message for any other ok:false", async () => {
    const fake = fakeSocket();
    attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => fake.sent.length === 1, "frame");

    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    resolveResult({ type: "result", ref: claims.jti, ok: false, error: "no such file" } satisfies NodeResultEvent);

    const err = await rejection(p);
    expect(err.code).toBe("failed");
    expect(err.message).toContain("no such file");
  });

  it("rejects `timeout` on the deadline and drops the pending entry", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, 30);
    await waitFor(() => fake.sent.length === 1, "frame");
    expect(conn.pending.size).toBe(1);

    const err = await rejection(p);
    expect(err.code).toBe("timeout");
    expect(conn.pending.size).toBe(0); // pending entry dropped

    // A late reply for the abandoned jti matches nothing.
    const claims = await unwrap(jwsOf(fake.sent, 0), "n1", publicJwk, new JtiLru(), new SeqTracker());
    expect(resolveResult({ type: "result", ref: claims.jti, ok: true } satisfies NodeResultEvent)).toBe(false);
  });

  it("a concurrent burst keeps seq strictly increasing in SENT order, each promise on its own jti", async () => {
    const fake = fakeSocket();
    attachConnection("n1", fake);

    // Distinct cmd payloads identify each call even once they interleave.
    const promises = [0, 1, 2, 3, 4].map((i) => sendCommand("n1", { type: "stat_dir", path: `/p${i}` }, 5000));
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
      resolveResult({ type: "result", ref: c.jti, ok: true, data: { jti: c.jti } });
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
    const err = await rejection(sendCommand("n1", { type: "ping" }, 1000));
    expect(err.code).toBe("failed");
    expect(conn.pending.size).toBe(0);
  });

  it("failAllFor rejects every pending with `offline` and clears the map", async () => {
    const fake = fakeSocket();
    const conn = attachConnection("n1", fake);
    const p1 = sendCommand("n1", { type: "ping" }, 5000);
    const p2 = sendCommand("n1", { type: "inventory" }, 5000);
    await waitFor(() => fake.sent.length === 2, "two frames");
    expect(conn.pending.size).toBe(2);

    expect(failAllFor("n1")).toBe(2);
    expect((await rejection(p1)).code).toBe("offline");
    expect((await rejection(p2)).code).toBe("offline");
    expect(conn.pending.size).toBe(0);
  });

  it("failConnPendings drains ONLY the given connection — the superseded-socket close path", async () => {
    const oldFake = fakeSocket();
    const oldConn = attachConnection("n1", oldFake);
    const p1 = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => oldFake.sent.length === 1, "old frame");

    // Supersede: the registry now maps the FRESH socket, but the old socket's
    // close event has not fired yet (its pending must survive until it does).
    const fresh = fakeSocket();
    const freshConn = attachConnection("n1", fresh);
    const p2 = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => fresh.sent.length === 1, "fresh frame");

    expect(failConnPendings(oldConn)).toBe(1); // targeted: only the old conn
    expect((await rejection(p1)).code).toBe("offline");
    expect(freshConn.pending.size).toBe(1); // the mapped connection is untouched
    expect(oldConn.pending.size).toBe(0);

    expect(failConnPendings(freshConn)).toBe(1);
    expect((await rejection(p2)).code).toBe("offline");
  });

  it("failAllFor honors a custom code/message and is a no-op for unknown nodes", async () => {
    const fake = fakeSocket();
    attachConnection("n1", fake);
    const p = sendCommand("n1", { type: "ping" }, 5000);
    await waitFor(() => fake.sent.length === 1, "frame");

    expect(failAllFor("n1", "failed", "node went away")).toBe(1);
    const err = await rejection(p);
    expect(err.code).toBe("failed");
    expect(err.message).toBe("node went away");

    expect(failAllFor("ghost")).toBe(0);
    expect(getLive("ghost")).toBeUndefined();
  });
});
