import { describe, expect, it } from "bun:test";
import type { RelayFrame } from "@internal/subshell-protocol";
import {
  onRelayFrame,
  onRelayFrameOverCap,
  relayFramesSeenFor,
  relayOverCapsSeenFor,
  resetRelayFramesForTests,
} from "../relay-frames.js";

/**
 * The Task-4 seam (spec 2026-10-08 §5.1): validation happened upstream
 * (parseRelayFrame via the handler's parse), the held/supersede guards
 * upstream of that, and the version gate upstream of everything. What this
 * file pins is the stub's CONTRACT that Task 8's broker inherits: route in,
 * recorded verbatim out, blob never touched. The end-to-end routing (which
 * socket a frame reaches only after a brokered open) is Task 8's suite.
 */

const frame: RelayFrame = {
  type: "relay",
  ref: "r-4f2a",
  seq: 0,
  direction: "B2A",
  blob: "QUJDk5+ToQ==",
};

describe("onRelayFrame (the pre-broker stub)", () => {
  it("records a routed frame per node, verbatim and blob-intact", () => {
    resetRelayFramesForTests();
    onRelayFrame("n-a", frame);
    expect(relayFramesSeenFor("n-a")).toEqual({ frames: 1, last: frame });
    // The stub is not a reader: the stored frame is the SAME shape that went
    // in, base64 kept as the opaque string §5.5 demands, decoded nowhere.
    expect(relayFramesSeenFor("n-a")?.last.blob).toBe(frame.blob);
  });

  it("counts per node and keeps only the newest frame", () => {
    resetRelayFramesForTests();
    onRelayFrame("n-b", frame);
    onRelayFrame("n-b", { ...frame, seq: 1, direction: "A2B" });
    expect(relayFramesSeenFor("n-b")).toEqual({ frames: 2, last: { ...frame, seq: 1, direction: "A2B" } });
    // Per-node isolation: A's traffic is not B's record.
    expect(relayFramesSeenFor("n-a")).toBeUndefined();
  });

  it("reset clears the registry (the --parallel fresh-registry posture)", () => {
    onRelayFrame("n-c", frame);
    resetRelayFramesForTests();
    expect(relayFramesSeenFor("n-c")).toBeUndefined();
  });
});

describe("onRelayFrameOverCap (the pre-broker over-cap stub, Task 4 review)", () => {
  it("counts refusals per node and keeps ONLY the ref; the blob never comes", () => {
    resetRelayFramesForTests();
    onRelayFrameOverCap("n-d", "r-1");
    expect(relayOverCapsSeenFor("n-d")).toEqual({ overCaps: 1, lastRef: "r-1" });
    onRelayFrameOverCap("n-d", "r-2");
    expect(relayOverCapsSeenFor("n-d")).toEqual({ overCaps: 2, lastRef: "r-2" });
    // Per-node isolation, same posture as the routed stub.
    expect(relayOverCapsSeenFor("n-e")).toBeUndefined();
    // The record has no blob slot at all: an over-cap frame is refused
    // unread, and the stub could not store the bytes even if it wanted to.
    expect(Object.keys(relayOverCapsSeenFor("n-d") ?? {})).toEqual(["overCaps", "lastRef"]);
  });

  it("the two seams are independent, and reset clears both", () => {
    resetRelayFramesForTests();
    onRelayFrameOverCap("n-f", "r-9");
    expect(relayFramesSeenFor("n-f")).toBeUndefined(); // a refusal is not a routed frame
    onRelayFrame("n-f", frame);
    expect(relayOverCapsSeenFor("n-f")).toEqual({ overCaps: 1, lastRef: "r-9" }); // a route is not a refusal
    resetRelayFramesForTests();
    expect(relayOverCapsSeenFor("n-f")).toBeUndefined();
    expect(relayFramesSeenFor("n-f")).toBeUndefined();
  });
});
