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

  it("rejects a foreign keypair and a malformed envelope", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const other = await generateControlKeys();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    expect(await verifyCommand(jws, other.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "signature",
    });
    // Appending to the SIGNATURE segment: broken crypto/format, not a payload edit.
    expect(await verifyCommand(`${jws}x`, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects a real payload tamper (byte flipped in the payload segment)", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signCommand(keys.privateJwk, { nodeId: "n1", jti: "j1", seq: 1, cmd });
    const [header, payload, signature] = jws.split(".");
    // Swap the first base64url char for another valid one — the envelope stays
    // 3-part and decodable-looking; only the signature check can catch it.
    const flipped = payload[0] === "A" ? "B" : "A";
    const tampered = `${header}.${flipped}${payload.slice(1)}.${signature}`;
    expect(await verifyCommand(tampered, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
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
      iss: "subshell-control",
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

describe("claims layer (iss/aud/exp/iat, signed with the RIGHT key)", () => {
  const base = (over: Record<string, unknown>) => ({
    iss: "subshell-control",
    aud: "node:n1",
    jti: "j1",
    seq: 1,
    cmd: { type: "ping" },
    ...over,
  });

  it("rejects the wrong issuer", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signRawClaims(keys.privateJwk, base({ iss: "mallory-control" }));
    expect(await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "claims",
    });
  });

  it("accepts an aud ARRAY that contains the node's audience", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signRawClaims(keys.privateJwk, base({ aud: ["node:other", "node:n1"] }));
    const out = await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq });
    expect(out.ok).toBe(true);
  });

  it("rejects an iat in the future beyond the 5 s skew", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const future = Math.floor(Date.now() / 1000) + 60;
    const jws = await signRawClaims(keys.privateJwk, base({ iat: future }));
    expect(await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "claims",
    });
  });

  it("rejects a command with NO exp claim (indefinite validity is not a long one)", async () => {
    const { keys, jtiLru, seq } = await fixtures();
    const jws = await signRawClaims(keys.privateJwk, base({}), { omitExp: true });
    expect(await verifyCommand(jws, keys.publicJwk, { nodeId: "n1", jtiLru, seqTracker: seq })).toEqual({
      ok: false,
      reason: "claims",
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
