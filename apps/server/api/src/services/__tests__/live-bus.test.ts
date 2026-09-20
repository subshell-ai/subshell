import { describe, expect, it } from "bun:test";
import { type LiveEvent, publishLive, subscribeLive } from "@/services/live-bus.js";

describe("live-bus", () => {
  it("delivers a published event to every subscriber", () => {
    const a: LiveEvent[] = [];
    const b: LiveEvent[] = [];
    const offA = subscribeLive((e) => a.push(e));
    const offB = subscribeLive((e) => b.push(e));
    try {
      publishLive({ kind: "subshell.changed", id: "s1" });
      expect(a).toEqual([{ kind: "subshell.changed", id: "s1" }]);
      expect(b).toEqual([{ kind: "subshell.changed", id: "s1" }]);
    } finally {
      offA();
      offB();
    }
  });

  it("stops delivering after unsubscribe", () => {
    const seen: LiveEvent[] = [];
    const off = subscribeLive((e) => seen.push(e));
    publishLive({ kind: "node.changed", id: "n1" });
    off();
    publishLive({ kind: "node.changed", id: "n2" });
    expect(seen).toEqual([{ kind: "node.changed", id: "n1" }]);
  });

  /**
   * The load-bearing one: publishers are mutation paths (create, terminate,
   * the reconcile sweep). A subscriber that throws is one browser socket
   * having a bad time — it must never become a failed terminate, and it must
   * not rob the OTHER subscribers of the event either.
   */
  it("isolates a throwing subscriber from the publisher and from its peers", () => {
    const after: LiveEvent[] = [];
    const offBad = subscribeLive(() => {
      throw new Error("subscriber blew up");
    });
    const offGood = subscribeLive((e) => after.push(e));
    try {
      expect(() => publishLive({ kind: "subshell.changed", id: "s1" })).not.toThrow();
      expect(after).toEqual([{ kind: "subshell.changed", id: "s1" }]);
    } finally {
      offBad();
      offGood();
    }
  });

  it("unsubscribes idempotently", () => {
    const seen: LiveEvent[] = [];
    const off = subscribeLive((e) => seen.push(e));
    off();
    off();
    publishLive({ kind: "subshell.changed", id: "s1" });
    expect(seen).toEqual([]);
  });

  it("carries the owner on a deletion, since the row is gone by then", () => {
    const seen: LiveEvent[] = [];
    const off = subscribeLive((e) => seen.push(e));
    try {
      publishLive({ kind: "subshell.deleted", id: "s1", ownerId: "u1" });
      expect(seen).toEqual([{ kind: "subshell.deleted", id: "s1", ownerId: "u1" }]);
    } finally {
      off();
    }
  });
});
