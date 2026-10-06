import { describe, expect, test } from "bun:test";
import { SSH_SESSION_PUMP_CHUNK_BYTES } from "@internal/subshell-protocol";
import { pumpChunks } from "../commands/ssh-session.js";

/**
 * The `session_frame` pump bound (node-frames' own claim: raw stdout in
 * ≤ 192 KiB pieces). The pump may only ever cut the byte stream, never
 * reorder or lose it: pieces at the bound, offsets exact, concatenation
 * byte-identical. The session's codec reassembles frames across pushes, so
 * a cut at an arbitrary byte is legal by design (review Minor, folded with
 * C1's framing family).
 */
describe("pumpChunks (session_frame bound)", () => {
  test("a read at or under the bound passes through as ONE piece", () => {
    const small = new Uint8Array(1024).fill(0xab);
    expect(pumpChunks(small, SSH_SESSION_PUMP_CHUNK_BYTES)).toEqual([small]);
    const at = new Uint8Array(SSH_SESSION_PUMP_CHUNK_BYTES).fill(0xcd);
    expect(pumpChunks(at, SSH_SESSION_PUMP_CHUNK_BYTES)).toEqual([at]);
  });

  test("a longer read splits at the bound, pieces are ≤ bound, and the concat is byte-identical", () => {
    const big = new Uint8Array(SSH_SESSION_PUMP_CHUNK_BYTES * 2 + 777).fill(0);
    for (let i = 0; i < big.byteLength; i++) big[i] = i % 251; // any deterministic non-flat pattern
    const parts = pumpChunks(big, SSH_SESSION_PUMP_CHUNK_BYTES);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(SSH_SESSION_PUMP_CHUNK_BYTES);
    const joined = new Uint8Array(big.byteLength);
    let off = 0;
    for (const p of parts) {
      joined.set(p, off);
      off += p.byteLength;
    }
    expect(off).toBe(big.byteLength);
    expect(Buffer.from(joined).equals(Buffer.from(big))).toBe(true);
  });

  test("an empty read is one empty piece (the pump's no-op stays a no-op, not zero pieces of nothing)", () => {
    expect(pumpChunks(new Uint8Array(0), SSH_SESSION_PUMP_CHUNK_BYTES)).toEqual([new Uint8Array(0)]);
  });
});
