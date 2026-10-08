import { afterEach, describe, expect, it } from "bun:test";
import type { RelayFrame } from "@internal/subshell-protocol";
import { type RelayBroker, setRelayBrokerForTests } from "@/services/ssh-relay.service.js";
import {
  onNodeSocketClosed,
  onRelayFrame,
  onRelayFrameOverCap,
  relayFramesSeenFor,
  relayOverCapsSeenFor,
  resetRelayFramesForTests,
} from "../relay-frames.js";

/**
 * The Task-8 seam (spec 2026-10-08 §5.1/§5.3/§5.5): validation happened
 * upstream (parseRelayFrame via the handler's parse), the held/supersede
 * guards upstream of that, and the version gate upstream of everything. This
 * file pins the SEAM's own contract now that the broker is real: every entry
 * point reaches the broker, the per-node record is a routing SUMMARY with no
 * blob slot anywhere (§5.5), a throwing broker never escapes the seam, and
 * the test reset keeps suites isolated under `bun test --parallel`.
 */

const frame: RelayFrame = {
  type: "relay",
  ref: "r-4f2a",
  seq: 0,
  direction: "B2A",
  blob: "QUJDk5+ToQ==",
};

/** A recording broker: the seam's three verbs, counted, with an optional throw. */
function spyBroker(overrides: Partial<RelayBroker> = {}) {
  const calls: { route: [string, RelayFrame][]; overCap: string[]; socketClosed: string[] } = {
    route: [],
    overCap: [],
    socketClosed: [],
  };
  const noop = (): RelayBroker["closeRelay"] => async () => false;
  const broker: RelayBroker = {
    openRelay: async () => {
      throw new Error("seam test must not open");
    },
    routeRelayFrame: (nodeId, f) => {
      calls.route.push([nodeId, f]);
    },
    closeRelay: noop(),
    closeForGrant: async () => 0,
    closeForPane: async () => 0,
    refuseOverCap: async (ref) => {
      calls.overCap.push(ref);
      return false;
    },
    onNodeSocketClosed: async (nodeId) => {
      calls.socketClosed.push(nodeId);
      return 0;
    },
    activeRelayCount: () => 0,
    sessionInfo: () => null,
    reset: () => {},
    ...overrides,
  };
  return { broker, calls };
}

afterEach(() => {
  setRelayBrokerForTests(null);
  resetRelayFramesForTests();
});

describe("onRelayFrame (the brokered seam, Task 8)", () => {
  it("hands the broker the EXACT frame object and records a blob-free summary", () => {
    const { broker, calls } = spyBroker();
    setRelayBrokerForTests(broker);
    resetRelayFramesForTests();
    onRelayFrame("n-a", frame);
    expect(calls.route).toHaveLength(1);
    expect(calls.route[0]?.[0]).toBe("n-a");
    expect(calls.route[0]?.[1]).toBe(frame); // by reference: the blind hand-off
    const seen = relayFramesSeenFor("n-a");
    expect(seen).toEqual({ frames: 1, lastRef: "r-4f2a", lastDirection: "B2A" });
    // §5.5, structurally: the record has no blob slot at all - the seam
    // could not hold the bytes even if a test asked it to.
    expect(Object.keys(seen ?? {})).toEqual(["frames", "lastRef", "lastDirection"]);
    expect(JSON.stringify(seen)).not.toContain(frame.blob);
    expect(JSON.stringify(seen)).not.toContain("QUJD");
  });

  it("counts per node and keeps only the newest routing facts", () => {
    const { broker } = spyBroker();
    setRelayBrokerForTests(broker);
    resetRelayFramesForTests();
    onRelayFrame("n-b", frame);
    onRelayFrame("n-b", { ...frame, ref: "r-5", seq: 1, direction: "A2B" });
    expect(relayFramesSeenFor("n-b")).toEqual({ frames: 2, lastRef: "r-5", lastDirection: "A2B" });
    // Per-node isolation: A's traffic is not B's record.
    expect(relayFramesSeenFor("n-a")).toBeUndefined();
  });

  it("a throwing broker is CONTAINED (the handler's frame chain survives)", () => {
    const { broker } = spyBroker({
      routeRelayFrame: () => {
        throw new Error("broker exploded");
      },
    });
    setRelayBrokerForTests(broker);
    resetRelayFramesForTests();
    expect(() => onRelayFrame("n-c", frame)).not.toThrow();
    expect(relayFramesSeenFor("n-c")).toEqual({ frames: 1, lastRef: "r-4f2a", lastDirection: "B2A" });
  });
});

describe("onRelayFrameOverCap (the named refusal, §5.1)", () => {
  it("refuses BY NAME through the broker and records ONLY the ref", async () => {
    const { broker, calls } = spyBroker();
    setRelayBrokerForTests(broker);
    resetRelayFramesForTests();
    onRelayFrameOverCap("n-d", "r-1");
    onRelayFrameOverCap("n-d", "r-2");
    await Promise.resolve();
    expect(calls.overCap).toEqual(["r-1", "r-2"]);
    expect(relayOverCapsSeenFor("n-d")).toEqual({ overCaps: 2, lastRef: "r-2" });
    // Per-node isolation, same posture as the routed summary.
    expect(relayOverCapsSeenFor("n-e")).toBeUndefined();
    expect(Object.keys(relayOverCapsSeenFor("n-d") ?? {})).toEqual(["overCaps", "lastRef"]);
  });

  it("the seams are independent, and reset clears them", () => {
    const { broker } = spyBroker();
    setRelayBrokerForTests(broker);
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

describe("onNodeSocketClosed (the a-dropped witness, §5.6)", () => {
  it("reports the dead node to the broker and never throws", async () => {
    const { broker, calls } = spyBroker();
    setRelayBrokerForTests(broker);
    onNodeSocketClosed("n-g");
    await Promise.resolve();
    expect(calls.socketClosed).toEqual(["n-g"]);
    const { broker: bad } = spyBroker({
      onNodeSocketClosed: () => Promise.reject(new Error("broker rejected the witness")),
    });
    setRelayBrokerForTests(bad);
    expect(() => onNodeSocketClosed("n-h")).not.toThrow();
  });
});
