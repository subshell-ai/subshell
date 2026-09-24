import { describe, expect, it } from "bun:test";
import { createPaneStreamRegistry, type PaneSource } from "@/ws/pane-stream.js";

/** A source the test drives by hand, recording start/stop for leak assertions. */
function fakeSource(): { source: PaneSource; emit: (text: string) => void; starts: number; stops: number } {
  const state = {
    starts: 0,
    stops: 0,
    emit: (_text: string) => {},
    source: {} as PaneSource,
  };
  state.source = {
    start(emit) {
      state.starts += 1;
      state.emit = emit;
      return () => {
        state.stops += 1;
        state.emit = () => {};
      };
    },
  };
  return state as { source: PaneSource; emit: (text: string) => void; starts: number; stops: number };
}

describe("createPaneStreamRegistry — one pump per subshell, fanned out", () => {
  it("starts the source once no matter how many viewers attach", () => {
    // The launcher contract forbids overlapping per-subshell pumps: two attach
    // streams on one pane can flip the read-your-writes order they rely on.
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();

    const a = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    const b = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );

    expect(fake.starts).toBe(1);
    a.close();
    b.close();
  });

  it("discardQueued drops only what arrived before the mark", () => {
    // The booting viewer's drop: bytes already inside its upcoming capture
    // must not be replayed ON TOP of it (a shell's transitional boot
    // sequences repaint as a ghost prompt), while everything after the mark
    // still flushes at open — a per-viewer drop, never a pump-wide one.
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();
    const a: string[] = [];
    const b: string[] = [];

    const subA = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => a.push(t),
    );
    const subB = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => b.push(t),
    );

    fake.emit("boot 1");
    fake.emit("boot 2");
    subA.discardQueued();
    fake.emit("after mark");
    subA.open();
    subB.open();

    expect(a).toEqual(["after mark"]);
    expect(b).toEqual(["boot 1", "boot 2", "after mark"]); // the drop is per-viewer

    subA.close();
    subB.close();
  });

  it("delivers every chunk to every OPEN subscriber", () => {
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();
    const a: string[] = [];
    const b: string[] = [];

    const subA = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => a.push(t),
    );
    const subB = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => b.push(t),
    );
    subA.open();
    subB.open();

    fake.emit("one");
    fake.emit("two");

    expect(a).toEqual(["one", "two"]);
    expect(b).toEqual(["one", "two"]);
    subA.close();
    subB.close();
  });

  it("QUEUES chunks until a subscriber opens, so a joiner's replay lands first", () => {
    // A late joiner subscribes BEFORE its replay is captured — that is what
    // makes the join gap-free — so anything the pane emits in between has to
    // wait behind the replay rather than race ahead of it.
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();
    const seen: string[] = [];

    const sub = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => seen.push(t),
    );
    fake.emit("mid-attach");
    expect(seen).toEqual([]); // still capturing the replay

    sub.open();
    expect(seen).toEqual(["mid-attach"]); // flushed, in order, after the replay
    fake.emit("live");
    expect(seen).toEqual(["mid-attach", "live"]);
    sub.close();
  });

  it("a joiner never receives bytes produced before it subscribed", () => {
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();
    const first: string[] = [];
    const late: string[] = [];

    const a = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => first.push(t),
    );
    a.open();
    fake.emit("before-joiner");

    const b = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => late.push(t),
    );
    b.open();
    fake.emit("after-joiner");

    // The joiner's own replay covers history; replaying the tail too would
    // paint pre-snapshot frames over a fresh capture.
    expect(first).toEqual(["before-joiner", "after-joiner"]);
    expect(late).toEqual(["after-joiner"]);
    a.close();
    b.close();
  });

  it("stops the source only when the LAST viewer leaves", () => {
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();

    const a = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    const b = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    a.close();
    expect(fake.stops).toBe(0); // b is still watching

    b.close();
    expect(fake.stops).toBe(1);
  });

  it("a re-subscribe after the last viewer left starts a FRESH source", () => {
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();

    registry
      .subscribe(
        "s1",
        () => fake.source,
        () => {},
      )
      .close();
    expect(fake.stops).toBe(1);

    const again = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    expect(fake.starts).toBe(2);
    again.close();
  });

  it("keeps subshells independent", () => {
    const registry = createPaneStreamRegistry();
    const one = fakeSource();
    const two = fakeSource();
    const seen1: string[] = [];
    const seen2: string[] = [];

    const a = registry.subscribe(
      "s1",
      () => one.source,
      (t) => seen1.push(t),
    );
    const b = registry.subscribe(
      "s2",
      () => two.source,
      (t) => seen2.push(t),
    );
    a.open();
    b.open();

    one.emit("for-one");
    expect(seen1).toEqual(["for-one"]);
    expect(seen2).toEqual([]);
    a.close();
    b.close();
  });

  it("close is idempotent and cannot stop a source a later viewer restarted", () => {
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();

    const a = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    a.close();
    a.close(); // double disconnect (the ws close path runs twice)
    expect(fake.stops).toBe(1);

    const b = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    a.close(); // the stale handle must not kill the new stream
    expect(fake.stops).toBe(1);
    b.close();
    expect(fake.stops).toBe(2);
  });

  it("one subscriber's delivery failure does not rob the others", () => {
    // A socket that throws on send is gone; the remaining viewers must still
    // get their bytes, or one dead tab silently freezes every other device.
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();
    const healthy: string[] = [];

    const bad = registry.subscribe(
      "s1",
      () => fake.source,
      () => {
        throw new Error("socket gone");
      },
    );
    const good = registry.subscribe(
      "s1",
      () => fake.source,
      (t) => healthy.push(t),
    );
    bad.open();
    good.open();

    fake.emit("chunk");
    expect(healthy).toEqual(["chunk"]);
    bad.close();
    good.close();
  });

  it("reports how many viewers a subshell has", () => {
    const registry = createPaneStreamRegistry();
    const fake = fakeSource();

    expect(registry.viewerCount("s1")).toBe(0);
    const a = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    expect(registry.viewerCount("s1")).toBe(1);
    const b = registry.subscribe(
      "s1",
      () => fake.source,
      () => {},
    );
    expect(registry.viewerCount("s1")).toBe(2);
    a.close();
    expect(registry.viewerCount("s1")).toBe(1);
    b.close();
    expect(registry.viewerCount("s1")).toBe(0);
  });
});
