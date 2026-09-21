import { describe, expect, it } from "bun:test";
import { CHUNK_MAX_BYTES, createInputQueue, FRAME_OVERHEAD_BYTES, type InputSender } from "@/lib/input-queue";

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

/**
 * The REAL serialized frame for one send. The belt is asserted against
 * JSON.stringify itself, not against the queue's own accounting, so a drift
 * between the two fails here rather than on a node.
 */
const frameBytes = (data: string, id: number) => utf8(JSON.stringify({ type: "input", data, id }));

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

  it("CHUNK: a 70 KB paste on a clear pipe becomes 3 chunks, ids sequential, order preserved", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    const paste = "x".repeat(70 * 1024);
    q.enqueue(paste);
    expect(sends.map(([, id]) => id)).toEqual([1, 2, 3]);
    expect(sends.map(([data]) => data).join("")).toBe(paste);
    expect(q.stats.depth).toBe(3);
  });

  it("CHUNK: the belt is the SERIALIZED frame, and no entry can ever exceed it", () => {
    // Printable text and control-character-heavy text cost different frame
    // bytes for the same string (\uXXXX is six bytes), so the size that
    // decides a split is the JSON frame's, not the string's. Asserted against
    // the real serializer, not the queue's own accounting: a drift between
    // the two fails here rather than on a node.
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("x".repeat(70 * 1024));
    const printableChunks = sends.length;
    for (const [data, id] of sends) expect(frameBytes(data, id as number)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
    // Drain so the second payload takes the fast path (its own chunks, sent).
    q.ack(1);
    q.ack(2);
    q.ack(3);
    sends.length = 0;
    q.enqueue("\u0001".repeat(70 * 1024)); // 6 frame bytes per character
    // The control-heavy payload is many more chunks for the same string
    // length, and still every serialized frame is under the cap.
    expect(sends.length).toBeGreaterThan(printableChunks);
    for (const [data, id] of sends) expect(frameBytes(data, id as number)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
    expect(sends.map(([data]) => data).join("")).toBe("\u0001".repeat(70 * 1024));
  });

  it("CHUNK: chunk boundaries never split a multi-byte character", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    // Emoji planted so the byte cut lands mid-character in every chunk but the last.
    const paste = `${"a".repeat(300)}🙂`.repeat(200);
    expect(utf8(paste)).toBeGreaterThan(CHUNK_MAX_BYTES);
    q.enqueue(paste);
    for (const [data, id] of sends) expect(frameBytes(data, id as number)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
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
    // One full-cap append: the tail takes as much as its budget allows and
    // the rest spills into a new chunk (the exact split point is the wire
    // budget's, so the assertions are properties, not hand-computed sizes).
    q.enqueue("c".repeat(CHUNK_MAX_BYTES));
    q.ack(1); // drain -> the backlog ships
    expect(sends.length).toBe(3);
    const [chunk2, chunk3] = sends.slice(1).map(([data]) => data as string);
    expect(chunk2.startsWith("b".repeat(100))).toBe(true);
    expect(chunk2 + chunk3).toBe("b".repeat(100) + "c".repeat(CHUNK_MAX_BYTES));
    for (const [data, id] of sends.slice(1))
      expect(frameBytes(data, id as number)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
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

  it("a flush the sender cannot deliver leaves the entry unsent backlog for the next reconnect", () => {
    const { state, sends, sender } = recordingSender(true);
    const q = createInputQueue(sender, now);
    q.engage();
    q.enqueue("a"); // id 1 sent, unacked
    q.enqueue("b"); // id 2, unsent backlog
    state.live = false; // the socket dies before the drain can flush
    q.ack(1); // the drain triggers the flush, but nothing can leave
    expect(sends).toEqual([["a", 1]]);
    // id 2 stays honest backlog, not a frame pretending to be in flight with
    // an ack that can never come; the reconnect's flush ships it.
    expect(q.stats.depth).toBe(1);
    state.live = true;
    q.resendPending();
    expect(sends).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("CHUNK: a lone-surrogate payload is budgeted at its real 6-byte frame cost", () => {
    const { sends, sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    // JSON.stringify re-escapes an unpaired surrogate as \udXXX, six bytes,
    // so the walk must count 6: with the old 3-byte guess this payload
    // serialized ~2x past its budget and the belt would have been a lie.
    const lone = "\uD800".repeat(7000);
    q.enqueue(lone);
    for (const [data, id] of sends) expect(frameBytes(data, id as number)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
    expect(sends.map(([data]) => data).join("")).toBe(lone);
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

  it("input typed while disengaged with a dead attach is buffered, and engagement ships it as the first tracked chunks", () => {
    // The #117 regression: enqueue used to fire-and-forget into a dead
    // sender, so every byte pressed in the window between `onopen` and the
    // first `viewers` frame (the replay capture can be slow) was gone. Now
    // the sender's refusal buffers the bytes instead.
    const { state, sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    q.enqueue("abc");
    q.enqueue("de");
    expect(sends).toEqual([]);
    // Nothing is tracked yet, so the badge correctly shows an empty queue.
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
    state.live = true; // the first server frame made the attach live...
    q.engage(); // ...and the viewers frame engages: the buffer ships FIRST
    // Fresh ids from 1, in typing order. The buffer coalesced the two
    // enqueues into one piece under the chunk budget, exactly as the tracked
    // coalesce would have.
    expect(sends).toEqual([["abcde", 1]]);
    q.ack(1);
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
  });

  it("a buffered paste larger than one chunk ships as sequential tracked chunks in order", () => {
    const { state, sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    const big = "x".repeat(70 * 1024);
    q.enqueue(big);
    expect(sends).toEqual([]);
    state.live = true;
    q.engage();
    // The ordinary path, not a special one: the first chunk takes the wire,
    // the rest is coalesced backlog that waits for the drain.
    expect(sends.length).toBe(1);
    q.ack(1);
    expect(sends.map(([, id]) => id)).toEqual([1, 2, 3]);
    expect(sends.map(([data]) => data).join("")).toBe(big);
    for (const [data, id] of sends) expect(frameBytes(data, id as number)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
  });

  it("an old server (a viewers frame without acks) ships the buffered bytes bare, in order, with no ids", () => {
    const { state, sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    q.enqueue("abc");
    q.enqueue("de");
    expect(sends).toEqual([]);
    state.live = true;
    q.disengage(); // the old server's answer: bare, untracked, pre-queue behavior
    expect(sends).toEqual([["abcde", undefined]]);
    expect(q.stats).toEqual({ depth: 0, unackedOldestMs: null });
    // And bare-on-the-spot resumes: the steady state is byte-identical to
    // what every pre-queue client did.
    q.enqueue("f");
    expect(sends).toEqual([
      ["abcde", undefined],
      ["f", undefined],
    ]);
  });

  it("bare bytes buffered for a dead attach are dropped when the server answers without acks while still not live", () => {
    // Documented case, not an oversight: bare bytes are untracked by design,
    // an old server that dropped them has no recovery either, and this is
    // the exact outcome they had pre-queue (dropped at enqueue).
    const { sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    q.enqueue("lost");
    q.disengage();
    expect(sends).toEqual([]);
    expect(q.engaged).toBe(false);
    // The buffer is empty again, so later input buffers anew while dead.
    q.enqueue("later");
    expect(sends).toEqual([]);
  });

  it("ids keep counting monotonically after a pre-engage flush", () => {
    const { state, sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    q.enqueue("pre");
    state.live = true;
    q.engage(); // "pre" ships as id 1
    q.ack(1);
    q.enqueue("post"); // ordinary engaged enqueue: next id
    expect(sends.map(([, id]) => id)).toEqual([1, 2]);
  });

  it("the pre-engage buffer is capped like the queue: the oldest pieces go, the newest stay", () => {
    const { state, sends, sender } = recordingSender(false);
    const q = createInputQueue(sender, now);
    // Exactly one full budget per enqueue: the tail is left full by the
    // previous piece, so the next append can coalesce nothing and every
    // enqueue is exactly one buffer piece.
    const piece = "x".repeat(CHUNK_MAX_BYTES - FRAME_OVERHEAD_BYTES);
    for (let i = 0; i < 513; i++) q.enqueue(piece);
    state.live = true;
    q.engage();
    // 513 pieces entered, MAX_PENDING survived: the first-typed piece is
    // gone, exactly as an evicted pending frame is.
    expect(sends.length).toBe(1); // the first surviving piece on the wire
    q.ack(1); // the drain ships the remaining backlog in order
    expect(sends.length).toBe(512);
    expect(sends.map(([data]) => data).join("")).toBe(piece.repeat(512));
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

  it("the pending cap is a frame count matched to the server window, and drops the oldest, never the newest", () => {
    const { sender } = recordingSender();
    const q = createInputQueue(sender, now);
    q.engage();
    // Each enqueue is one byte over the chunk budget, so every one spills
    // into new frames: the only way to accumulate many frames while nothing
    // is acked. 512 enqueues produce 514 frames, two past the cap.
    const overCap = "x".repeat(CHUNK_MAX_BYTES + 1);
    for (let i = 0; i < 512; i++) q.enqueue(overCap);
    expect(q.stats.depth).toBe(512);
    // The oldest frames are gone; the newest is still pending and retirable.
    q.ack(514);
    expect(q.stats.depth).toBe(511);
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
