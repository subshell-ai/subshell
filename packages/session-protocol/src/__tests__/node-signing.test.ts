import { describe, expect, it } from "bun:test";
import type { NodeCommandBody } from "../node-frames.js";
import { generateControlKeys, JtiLru, SeqTracker, signCommand, signRawClaims, verifyCommand } from "../node-signing.js";

const cmd: NodeCommandBody = { type: "ping" };

async function fixtures() {
  const keys = await generateControlKeys();
  const jtiLru = new JtiLru();
  const seq = new SeqTracker();
  return { keys, jtiLru, seq };
}

describe("sign/verify round-trip", () => {
  it("verifies a fresh, correctly-addressed command", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    const out = await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims.cmd).toEqual(cmd);
  });

  it("rejects the wrong audience (command aimed at another node)", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    const out = await verifyCommand(jws, keys.publicJwk, { nodeId: "OTHER", jtiLru, seqTracker: seq });
    expect(out).toEqual({ ok: false, reason: "claims" });
  });

  it("rejects a foreign keypair and a tampered payload", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const other = await generateControlKeys();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    expect(await verifyCommand(jws, other.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await verifyCommand(`${jws}x`, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects after the TTL (exp) with a caller-supplied clock", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, {
      nodeId: "n1",
      jti: "j1",
      seq: 1,
      cmd,
      nowSec: 1_000_000,
    });
    const out = await verifyCommand(jws, keys.publicJwk, {
      nodeId: "n1",
      jtiLru,
      seqTracker: seq,
      nowSec: 1_000_031,
    });
    expect(out).toEqual({ ok: false, reason: "claims" });
  });

  it("rejects a replayed jti and a seq regression, independent of each other", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const a = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "jA", seq: 1, cmd });
    const b = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "jB", seq: 2, cmd });
    expect((await verifyCommand(a, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).ok).toBe(true);
    expect(await verifyCommand(a, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "replay",
    });
    // b is ahead of a — fine
    expect((await verifyCommand(b, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).ok).toBe(true);
    // a replay now fails as replay BEFORE seq logic even matters; craft regression with fresh jti:
    const c = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "jC", seq: 1, cmd });
    expect(await verifyCommand(c, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "seq",
    });
  });

  it("rejects a well-signed frame whose cmd is garbage", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signRawClaims(keys.privateJwk, {
      iss: "mote-control",
      aud: "node:n1",
      jti: "j1",
      seq: 1,
      cmd: { type: "wat" },
    });
    expect(await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("SeqTracker", () => {
  it("requires strict increase, resets per connection", () => {
    const s = new SeqTracker();
    expect(s.accept(1)).toBe(true);
    expect(s.accept(1)).toBe(false);
    expect(s.accept(3)).toBe(true); // gap tolerated
    expect(s.accept(2)).toBe(false); // regression rejected
    s.reset();
    expect(s.accept(1)).toBe(true);
  });
});

describe("JtiLru", () => {
  it("reports seen ids and evicts oldest beyond capacity", () => {
    const l = new JtiLru(2);
    expect(l.seen("a")).toBe(false);
    expect(l.seen("a")).toBe(true);
    l.seen("b");
    l.seen("c"); // evicts "a"
    expect(l.seen("a")).toBe(false);
  });
});
