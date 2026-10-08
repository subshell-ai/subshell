import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION, parseNodeEvent, parseRelayFrame } from "../node-frames.js";
import { SSH_RELAY_FRAME_MAX_BYTES } from "../ssh-limits.js";

/**
 * The sealed agent-relay link frame (spec 2026-10-08 §5.1): one sealed
 * envelope per frame, keyed by the opaque routing ref, direction-tagged,
 * blob-capped. The plane is a BLIND router - the grammar is the only thing
 * that touches the frame's SHAPE, and it never decodes `blob`.
 */

/** Strict base64 that decodes to EXACTLY n raw bytes (padded last group). */
function b64OfRawLength(n: number): string {
  const full = Math.floor(n / 3);
  const rem = n % 3;
  const body = "A".repeat(full * 4);
  if (rem === 0) return body;
  return rem === 1 ? `${body}AA==` : `${body}AAA=`;
}

const good = {
  type: "relay",
  ref: "r-4f2a",
  seq: 0,
  direction: "B2A",
  blob: b64OfRawLength(1024),
} as const;

describe("NODE_PROTOCOL_VERSION 18 (spec 2026-10-08 §5.1)", () => {
  it("18 is the relay tier: relay frames + the open/close commands", () => {
    // The bump is load-bearing: a tier-17 agent (M1) understands no relay
    // frame, and the exact-match gate is what refuses it BEFORE any frame is
    // accepted. Never half-relay.
    expect(NODE_PROTOCOL_VERSION).toBe(18);
  });
});

describe("parseRelayFrame", () => {
  it("accepts a valid frame and preserves every field", () => {
    expect(parseRelayFrame(good)).toEqual({ ...good });
    expect(parseRelayFrame(JSON.stringify(good))).toEqual({ ...good });
    expect(parseRelayFrame({ ...good, direction: "A2B", seq: 7 })).toMatchObject({ direction: "A2B", seq: 7 });
  });

  it("accepts a blob at exactly the cap and refuses one over it", () => {
    // The cap is on the RAW payload the base64 decodes to, measured exactly
    // (padding groups included) - a padded group that reads one byte longer
    // than a full one at the same spelling must not smuggle past it.
    const atCap = { ...good, blob: b64OfRawLength(SSH_RELAY_FRAME_MAX_BYTES) };
    expect(parseRelayFrame(atCap)).not.toBeNull();
    expect(parseRelayFrame({ ...good, blob: b64OfRawLength(SSH_RELAY_FRAME_MAX_BYTES + 1) })).toBeNull();
    expect(parseRelayFrame({ ...good, blob: "A".repeat(atCap.blob.length + 4) })).toBeNull();
    // One padded extra group appended: one raw byte over, and the char
    // count reads almost like the at-cap frame - the raw measurement is what
    // refuses it (§5.1's cap is law, not a char-count approximation).
    expect(parseRelayFrame({ ...good, blob: `${atCap.blob}AB==` })).toBeNull();
    // One byte UNDER the cap, padded last group: still legal.
    expect(parseRelayFrame({ ...good, blob: b64OfRawLength(SSH_RELAY_FRAME_MAX_BYTES - 1) })).not.toBeNull();
  });

  it("refuses malformed shapes", () => {
    expect(parseRelayFrame({ ...good, type: "not-relay" })).toBeNull();
    expect(parseRelayFrame({ ref: "r", seq: 0, direction: "B2A", blob: "AA==" })).toBeNull(); // no type
    expect(parseRelayFrame({ ...good, ref: "" })).toBeNull(); // empty routing ref
    expect(parseRelayFrame({ ...good })).not.toBeNull(); // (sanity for the line above)
    expect(parseRelayFrame({ ...good, seq: -1 })).toBeNull(); // seq is a monotonic counter
    expect(parseRelayFrame({ ...good, seq: 1.5 })).toBeNull();
    expect(parseRelayFrame({ ...good, direction: "A2A" })).toBeNull(); // only the two spellings
    expect(parseRelayFrame({ ...good, blob: "not base64 !!!" })).toBeNull();
    expect(parseRelayFrame({ ...good, blob: 42 })).toBeNull();
    expect(parseRelayFrame("nope")).toBeNull();
    expect(parseRelayFrame("null")).toBeNull(); // parses, and null is not a frame
    expect(parseRelayFrame(JSON.stringify([good]))).toBeNull(); // an array is not a record either
  });

  it("the relay kind joins the node-event narrowing (the plane's one inbound parse)", () => {
    // Every relay frame the PLANE sees arrives on the agent-to-plane inbound
    // path, which dispatches through parseNodeEvent; the kind must come back
    // from there, not fall to the unrecognized-drop.
    const event = parseNodeEvent({ ...good });
    expect(event?.type).toBe("relay");
    if (event?.type === "relay") {
      expect(event.ref).toBe("r-4f2a");
      expect(event.direction).toBe("B2A");
    }
    // A malformed relay frame stays NULL there, exactly as parseRelayFrame refuses it.
    expect(parseNodeEvent({ ...good, direction: "sideways" })).toBeNull();
  });
});
