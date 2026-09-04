import { describe, expect, it } from "bun:test";
import { createGeometryQueue, type PaneSizer } from "@/ws/pane-geometry.js";

/** A deferred, so a test can hold `apply` open and enqueue behind it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Recorder {
  sizer: PaneSizer;
  applied: Array<{ cols: number; rows: number }>;
  /** Resolves the apply currently in flight. */
  release: () => void;
  /** Rejects the apply currently in flight. */
  fail: (err: unknown) => void;
  /** What `read()` reports back — defaults to echoing the last apply. */
  readAs: { cols: number; rows: number } | null;
  reads: number;
}

/**
 * A sizer whose `apply` blocks until released, so coalescing is observable
 * rather than a race. `readAs` overrides the reported size to model tmux
 * clamping the request.
 */
function recorder(opts: { block?: boolean } = {}): Recorder {
  const state: Recorder = {
    applied: [],
    readAs: null,
    reads: 0,
    release: () => {},
    fail: () => {},
    sizer: {
      apply: async (cols, rows) => {
        state.applied.push({ cols, rows });
        if (!opts.block) return;
        const gate = deferred<void>();
        state.release = () => gate.resolve();
        state.fail = (e) => gate.reject(e);
        await gate.promise;
      },
      read: async () => {
        state.reads += 1;
        return state.readAs ?? state.applied.at(-1) ?? null;
      },
    },
  };
  return state;
}

/** Lets queued microtasks drain without depending on wall-clock timing. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createGeometryQueue — serialize + coalesce per subshell", () => {
  it("applies a single request and reports the size read back from the pane", async () => {
    const rec = recorder();
    const seen: Array<{ cols: number; rows: number }> = [];
    const queue = createGeometryQueue({ onGeometry: (_k, size) => seen.push(size) });

    queue.request("s1", 92, 28, rec.sizer);
    await settle();

    expect(rec.applied).toEqual([{ cols: 92, rows: 28 }]);
    expect(seen).toEqual([{ cols: 92, rows: 28 }]);
  });

  it("reports the pane's REAL size, not the requested one, when tmux clamps it", async () => {
    // The whole point of the readback: a client that believes it got 51x13
    // while the pane sits at 51x16 paints every later frame onto wrong rows.
    const rec = recorder();
    rec.readAs = { cols: 51, rows: 16 };
    const seen: Array<{ cols: number; rows: number }> = [];
    const queue = createGeometryQueue({ onGeometry: (_k, size) => seen.push(size) });

    queue.request("s1", 51, 13, rec.sizer);
    await settle();

    expect(seen).toEqual([{ cols: 51, rows: 16 }]);
  });

  it("collapses a burst behind an in-flight apply to LAST-WRITE-WINS", async () => {
    // A sash drag emits a resize per animation frame. Without coalescing each
    // one becomes a tmux round trip, and out-of-order completion can leave the
    // pane at a superseded size (the measured 92x28-vs-86x28 bounce).
    const rec = recorder({ block: true });
    const queue = createGeometryQueue({ onGeometry: () => {} });

    queue.request("s1", 80, 24, rec.sizer);
    await settle();
    expect(rec.applied).toEqual([{ cols: 80, rows: 24 }]);

    // Three more arrive while the first is still in flight.
    queue.request("s1", 81, 24, rec.sizer);
    queue.request("s1", 82, 25, rec.sizer);
    queue.request("s1", 90, 30, rec.sizer);
    await settle();
    // Still only the first — nothing overlapped it.
    expect(rec.applied).toEqual([{ cols: 80, rows: 24 }]);

    rec.release();
    await settle();

    // The three collapsed into one apply carrying the LAST request.
    expect(rec.applied).toEqual([
      { cols: 80, rows: 24 },
      { cols: 90, rows: 30 },
    ]);
  });

  it("skips a coalesced request that matches the size already applied", async () => {
    const rec = recorder({ block: true });
    const queue = createGeometryQueue({ onGeometry: () => {} });

    queue.request("s1", 80, 24, rec.sizer);
    await settle();
    queue.request("s1", 80, 24, rec.sizer);
    rec.release();
    await settle();

    expect(rec.applied).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("does not let one subshell's in-flight resize block another's", async () => {
    const a = recorder({ block: true });
    const b = recorder();
    const queue = createGeometryQueue({ onGeometry: () => {} });

    queue.request("a", 80, 24, a.sizer);
    await settle();
    queue.request("b", 100, 40, b.sizer);
    await settle();

    expect(b.applied).toEqual([{ cols: 100, rows: 40 }]);
    a.release();
    await settle();
  });

  it("survives a failing apply: the queue does not wedge and the next request runs", async () => {
    const rec = recorder({ block: true });
    const errors: unknown[] = [];
    const queue = createGeometryQueue({ onGeometry: () => {}, onError: (e) => errors.push(e) });

    queue.request("s1", 80, 24, rec.sizer);
    await settle();
    rec.fail(new Error("tmux gone"));
    await settle();

    expect(errors).toHaveLength(1);

    const next = recorder();
    queue.request("s1", 90, 30, next.sizer);
    await settle();
    expect(next.applied).toEqual([{ cols: 90, rows: 30 }]);
  });

  it("reports nothing when the pane's size cannot be read (dead pane)", async () => {
    const rec = recorder();
    rec.readAs = null;
    // `read` returning null must not be reported as a geometry of 0x0.
    rec.sizer.read = async () => null;
    const seen: Array<{ cols: number; rows: number }> = [];
    const queue = createGeometryQueue({ onGeometry: (_k, size) => seen.push(size) });

    queue.request("s1", 92, 28, rec.sizer);
    await settle();

    expect(seen).toEqual([]);
  });

  it("forgets a subshell's queue state on release, so ids can be reused", async () => {
    const rec = recorder();
    const queue = createGeometryQueue({ onGeometry: () => {} });

    queue.request("s1", 80, 24, rec.sizer);
    await settle();
    queue.release("s1");

    // Same size again: without the release this would be skipped as a no-op.
    queue.request("s1", 80, 24, rec.sizer);
    await settle();

    expect(rec.applied).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    ]);
  });
});
