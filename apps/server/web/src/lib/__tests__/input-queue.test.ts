import { describe, expect, it } from "bun:test";
import { createInputQueue, type InputSender } from "@/lib/input-queue";

/** A clock the tests advance by hand, so ages and RTTs are exact. */
let nowMs = 10_000;
const now = () => nowMs;
const advance = (ms: number) => {
  nowMs += ms;
};

/** Records sends as [data, id] pairs. */
function recordingSender() {
  const sends: Array<[string, number | undefined]> = [];
  const sender: InputSender = (data, id) => sends.push([data, id]);
  return { sends, sender };
}

describe("createInputQueue", () => {
  it("an unengaged queue sends bare frames and tracks nothing", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.enqueue("a");
    q.enqueue("b");
    expect(sends).toEqual([
      ["a", undefined],
      ["b", undefined],
    ]);
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
  });

  it("an engaged queue assigns monotonic ids and sends immediately", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    expect(sends).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(q.stats.depth).toBe(3);
    // The oldest is 2 units old: two enqueues advanced the fake clock by 2.
    advance(2);
    expect(q.stats.unackedOldestMs).toBe(2);
  });

  it("ack retires the id and records its round-trip time", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    advance(40);
    q.enqueue("b");
    advance(20);
    q.ack(1); // 40 + 20 since "a" was sent
    q.ack(2); // 20 since "b" was sent
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
    expect(q.rtt.p50).toBe(40);
    expect(q.rtt.max).toBe(60);
    expect(q.rtt.count).toBe(2);
  });

  it("an ack for an id the queue never sent is ignored", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    expect(() => q.ack(99)).not.toThrow();
    expect(q.rtt.count).toBe(0);
  });

  it("resendPending re-sends unacked inputs in id order with their original ids", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    q.ack(2);
    sends.length = 0;
    advance(500);
    q.resendPending();
    expect(sends).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
    // The re-send restarts each id's RTT clock: the age the client measures
    // after this is since the resend, not since the first send.
    expect(q.stats.unackedOldestMs).toBe(0);
  });

  it("enqueue while the socket is down is retained and flushed by the next resend", () => {
    // The sender reads the live socket at call time; with it down the send is
    // a no-op, but the queue still tracks what was typed.
    let live = false;
    const sends: Array<[string, number | undefined]> = [];
    const q = createInputQueue((data, id) => {
      if (live) sends.push([data, id]);
    }, now);
    q.engage();
    q.enqueue("typed offline");
    expect(sends).toEqual([]);
    expect(q.stats.depth).toBe(1);
    live = true; // the reconnect
    q.resendPending();
    expect(sends).toEqual([["typed offline", 1]]);
  });

  it("disengage drops the backlog: ids a non-acking server will never retire", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    q.enqueue("b");
    expect(q.stats.depth).toBe(2);
    q.disengage();
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
    expect(q.engaged).toBe(false);
    // And the queue is back to fire-and-forget.
    q.enqueue("c");
    expect(sends.at(-1)).toEqual(["c", undefined]);
  });

  it("onStats fires on enqueue, ack and resend, and unsubscribes", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    let calls = 0;
    const unsubscribe = q.onStats(() => {
      calls++;
    });
    q.engage();
    q.enqueue("a");
    q.ack(1);
    q.resendPending();
    expect(calls).toBe(3);
    unsubscribe();
    q.enqueue("b");
    expect(calls).toBe(3);
  });

  it("the pending cap drops the oldest, never the newest", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    for (let i = 1; i <= 1025; i++) q.enqueue(`k${i}`);
    expect(q.stats.depth).toBe(1024);
    q.ack(1025);
    expect(q.stats.depth).toBe(1023);
  });

  it("an empty enqueue is a no-op in both modes", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.enqueue("");
    q.engage();
    q.enqueue("");
    expect(sends).toEqual([]);
  });
});
