import { describe, expect, it } from "bun:test";
import { CHUNK_MAX_BYTES, createInputQueue, type InputSender } from "@/lib/input-queue";

/** A clock the tests advance by hand, so ages and RTTs are exact. */
let nowMs = 10_000;
const now = () => nowMs;
const advance = (ms: number) => {
  nowMs += ms;
};

/** Records sends as [data, id] pairs; `live` stands in for the attach. */
function recordingSender(live = true) {
  const state = { live };
  const sends: Array<[string, number | undefined]> = [];
  const sender: InputSender = (data, id) => {
    if (!state.live) return false;
    sends.push([data, id]);
    return true;
  };
  return { state, sends, sender };
}

/** UTF-8 byte length, matching the queue's own accounting. */
const utf8 = (s: string) => new TextEncoder().encode(s).length;

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

  it("an engaged queue sends immediately while the pipe is clear, ids monotonic", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    expect(sends).toEqual([["a", 1]]);
    q.ack(1);
    advance(5);
    q.enqueue("b");
    expect(sends).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(q.stats.depth).toBe(1);
  });

  it("CHUNK: a 70 KB paste on a clear pipe becomes 3 chunks of <= 32 KiB, ids sequential, order preserved", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    // 70 KB of ASCII: 71680 bytes = 32768 + 32768 + 6144.
    const paste = "x".repeat(70 * 1024);
    q.enqueue(paste);
    expect(sends.map(([, id]) => id)).toEqual([1, 2, 3]);
    expect(sends.map(([data]) => utf8(data))).toEqual([32768, 32768, 6144]);
    expect(sends.map(([data]) => data).join("")).toBe(paste);
    expect(q.stats.depth).toBe(3);
  });

  it("CHUNK: chunk boundaries never split a multi-byte character", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    // Emoji planted so the byte cut lands mid-character in every chunk but the last.
    const paste = `${"a".repeat(300)}🙂`.repeat(200);
    expect(utf8(paste)).toBeGreaterThan(CHUNK_MAX_BYTES);
    q.enqueue(paste);
    for (const [data] of sends) expect(utf8(data)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
    expect(sends.map(([data]) => data).join("")).toBe(paste);
  });

  it("COALESCE: three enqueues while unacked join the tail and ship as one frame on the drain", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a"); // fast path: id 1 on the wire, unacked
    q.enqueue("b"); // backpressure: joins the unsent tail (id 2)
    q.enqueue("c"); // joins the same tail
    // Only the first frame ever left; the burst is one queued frame.
    expect(sends).toEqual([["a", 1]]);
    expect(q.stats).toEqual({ depth: 2, unackedOldestMs: 0 });
    advance(30);
    // The ack that drains the pipe is the flush trigger: id 2 leaves whole.
    q.ack(1);
    expect(sends).toEqual([
      ["a", 1],
      ["bc", 2],
    ]);
    q.ack(2);
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
  });

  it("COALESCE: the burst fills the tail to the chunk cap and spills the residue", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("seed"); // id 1, sent
    q.enqueue("b".repeat(100)); // id 2, unsent tail with room to spare
    q.enqueue("c".repeat(CHUNK_MAX_BYTES - 50)); // fills id 2 to the cap, spills 50 bytes
    q.ack(1); // drain -> the backlog ships
    expect(sends.slice(1)).toEqual([
      ["b".repeat(100) + "c".repeat(CHUNK_MAX_BYTES - 100), 2],
      ["c".repeat(50), 3],
    ]);
    expect(q.stats.depth).toBe(2);
  });

  it("COALESCE: a sent tail is frozen; the burst opens a new unsent frame", () => {
    // The frozen-frames rule: an entry's id names exactly the bytes the server
    // may have written, so appending to a SENT entry would make its retry
    // re-send text the dedupe window already dropped, losing the appended
    // part. The appendable thing is unsent data only.
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    q.enqueue("b"); // depth > 0, tail (id 1) is sent -> new unsent frame
    expect(sends).toEqual([["a", 1]]);
    q.ack(1);
    expect(sends).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("the backlog ships in id order after the drain, oldest first", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a"); // id 1, sent
    q.enqueue("b"); // id 2, unsent
    q.enqueue("c"); // joins id 2
    q.ack(1);
    expect(sends.map(([, id]) => id)).toEqual([1, 2]);
  });

  it("resendPending ships the sent frames AND the unsent backlog, ids unchanged, in id order", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a"); // id 1, on the wire, unacked
    q.enqueue("b"); // id 2, coalesced backlog, never sent
    q.enqueue("c"); // joins id 2
    expect(sends).toEqual([["a", 1]]);
    sends.length = 0;
    advance(500);
    q.resendPending();
    // id 1 is re-sent for the reconnect; the coalesced id 2 ships here for
    // the first time. Neither id changes: the server's window absorbs id 1
    // if its first send landed.
    expect(sends).toEqual([
      ["a", 1],
      ["bc", 2],
    ]);
  });

  it("an offline attach holds input as unsent backlog and the reconnect flushes it", () => {
    const { state, sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("typed offline");
    q.enqueue("more offline"); // coalesces into the unsent tail
    expect(sends).toEqual([]);
    expect(q.stats).toEqual({ depth: 1, unackedOldestMs: 0 });
    state.live = true; // the reconnect
    q.resendPending();
    expect(sends).toEqual([["typed offlinemore offline", 1]]);
  });

  it("ack records the round-trip time against the LAST send", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a"); // id 1 sent at t=10000
    advance(40);
    q.enqueue("b"); // coalesced into unsent id 2 at t=10040
    advance(20);
    q.ack(1); // RTT 60 for id 1; the drain flushes id 2 at t=10060
    q.ack(2); // RTT 0 for id 2 (sent and acked in the same tick)
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
    expect(q.rtt.p50).toBe(30);
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

  it("a resend restarts each id's RTT clock", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    advance(100);
    q.resendPending(); // re-sent at t=10100
    advance(5);
    q.ack(1);
    expect(q.rtt.count).toBe(1);
    expect(q.rtt.p50).toBe(5);
  });

  it("disengage drops the backlog: ids a non-acking server will never retire", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a");
    q.enqueue("b"); // coalesced backlog
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

  it("the pending cap is a frame count and drops the oldest, never the newest", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    // Each enqueue is one byte over the cap, so every one spills into its own
    // frame: the only way to accumulate many frames while nothing is acked.
    const overCap = "x".repeat(CHUNK_MAX_BYTES + 1);
    for (let i = 0; i < 1024; i++) q.enqueue(overCap);
    expect(q.stats.depth).toBe(1024);
    // The oldest frame is gone; the newest is still pending and retirable.
    q.ack(1024);
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
