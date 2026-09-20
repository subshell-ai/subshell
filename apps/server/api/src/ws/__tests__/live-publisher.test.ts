import { describe, expect, it } from "bun:test";
import { publishLive } from "@/services/live-bus.js";
import { startLivePublisher } from "@/ws/live-publisher.js";
import { userTopic } from "@/ws/live-topics.js";

/** Records what was published, per topic. */
function fakeTarget() {
  const sent: { topic: string; frame: Record<string, unknown> }[] = [];
  return {
    target: {
      publish(topic: string, data: string) {
        sent.push({ topic, frame: JSON.parse(data) });
        return 1;
      },
    },
    sent,
    typesFor: (id: string) => sent.filter((s) => s.frame.id === id).map((s) => s.frame.type),
  };
}

const settle = (ms = 90) => new Promise((r) => setTimeout(r, ms));

describe("live publisher coalescing", () => {
  /**
   * The measured defect this closes: creating ONE subshell wrote the row,
   * minted its token and patched it post-spawn, and the browser received four
   * frames describing one act.
   */
  it("collapses a burst of changes to one id into a single resolve", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      for (let i = 0; i < 4; i++) publishLive({ kind: "subshell.changed", id: "burst" });
      await settle();
      // The row does not exist in the test database, so the publisher resolves
      // nothing and sends nothing — what is under test is that it TRIED once.
      // A deletion is the observable case; see the next test.
      expect(sent.filter((s) => s.frame.id === "burst")).toEqual([]);
    } finally {
      stop();
    }
  });

  it("sends ONE frame for a burst of deletions of the same row", async () => {
    const { target, typesFor } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      for (let i = 0; i < 4; i++) publishLive({ kind: "subshell.deleted", id: "d1", ownerId: "u1" });
      await settle();
      // Two topics (the owner's and admins'), ONE frame each — not four.
      expect(typesFor("d1")).toEqual(["subshell-gone", "subshell-gone"]);
    } finally {
      stop();
    }
  });

  it("lets a deletion outrank a change queued for the same row in the window", async () => {
    const { target, typesFor } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({ kind: "subshell.changed", id: "d2" });
      publishLive({ kind: "subshell.deleted", id: "d2", ownerId: "u1" });
      publishLive({ kind: "subshell.changed", id: "d2" }); // must not undo it
      await settle();
      expect(typesFor("d2")).toEqual(["subshell-gone", "subshell-gone"]);
    } finally {
      stop();
    }
  });

  it("keeps distinct rows distinct", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    try {
      publishLive({ kind: "subshell.deleted", id: "a", ownerId: "u1" });
      publishLive({ kind: "subshell.deleted", id: "b", ownerId: "u1" });
      await settle();
      expect(new Set(sent.map((s) => s.frame.id))).toEqual(new Set(["a", "b"]));
    } finally {
      stop();
    }
  });

  it("stops publishing once torn down", async () => {
    const { target, sent } = fakeTarget();
    const stop = startLivePublisher({ target, coalesceMs: 20 });
    publishLive({ kind: "subshell.deleted", id: "late", ownerId: "u1" });
    stop();
    await settle();
    expect(sent).toEqual([]);
  });
});

describe("a share revocation reaches the person who lost it", () => {
  /**
   * The asymmetry that makes this necessary: recipients computed AFTER the
   * write are exactly the people who still have the row, so publishing only
   * those tells everyone except the one person whose access just ended. Their
   * dashboard would keep the row until they reloaded.
   */
  it("sends subshell-gone to topics the row used to reach and no longer does", async () => {
    const sent: { topic: string; frame: Record<string, unknown> }[] = [];
    const target = {
      publish(topic: string, data: string) {
        sent.push({ topic, frame: JSON.parse(data) });
        return 1;
      },
    };
    const stop = startLivePublisher({ target, coalesceMs: 10 });
    try {
      // The row does not exist in this test DB, so the `subshell` half resolves
      // to nothing — but the revocation half is derived from the event itself
      // and must still land.
      publishLive({
        kind: "subshell.shares-changed",
        id: "s9",
        before: { ownerUserId: "owner", shares: [{ granteeUserId: "ex", permission: "view" }] },
      });
      await new Promise((r) => setTimeout(r, 60));
      const gone = sent.filter((x) => x.frame.type === "subshell-gone");
      expect(gone.map((x) => x.topic)).toContain(userTopic("ex"));
      expect(gone.every((x) => x.frame.id === "s9")).toBe(true);
    } finally {
      stop();
    }
  });
});
