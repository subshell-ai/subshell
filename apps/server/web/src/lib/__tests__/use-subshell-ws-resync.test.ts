import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { needsGridResync, setAttachResyncTimingsForTests, useSubshellWs } from "@/lib/use-subshell-ws";

/**
 * Grid resync: the attach path is the only thing that can give a viewer a
 * TRUE base (absolute capture, cursor restore, confirmed geometry), and the
 * reported failure mode is a viewer whose base went false mid-session, the
 * way only the attach can heal it.
 *
 * The window: the pane resizes (another viewer joined, a window was dragged)
 * and re-anchors its pinned block with relative moves, while this client is
 * still parsing bytes against the grid its replay was painted for. Those
 * bytes are unrecoverable by ordering — no hold fixes frames emitted on a
 * grid the client will never show — so when the client adopts a grid that
 * differs from its established one AND has applied pane bytes since, the
 * only honest act is to run the attach again.
 */

function fakeTerminal() {
  const resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
  const term = {
    options: { disableStdin: false } as { disableStdin: boolean },
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: () => {} }),
    onResize: (h: (size: { cols: number; rows: number }) => void) => {
      resizeHandlers.push(h);
      return { dispose: () => {} };
    },
    resizeHandlers,
    reset: () => {},
    write: () => {},
  };
  return term;
}
type FakeTerm = ReturnType<typeof fakeTerminal>;

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onerror?: () => void;
  readonly sent: Array<string | Uint8Array> = [];
  constructor(_url: string) {
    instances.push(this);
  }
  send(_data: string | Uint8Array): void {}
  close(): void {
    // Mirror the browser: a close dispatches the close event, and the hook's
    // ONE reconnect path lives in that handler (code 1006: a drop, retryable).
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}
const instances: FakeWebSocket[] = [];

let originalFetch: typeof fetch;
let originalWs: typeof globalThis.WebSocket;

beforeEach(() => {
  instances.length = 0;
  originalFetch = globalThis.fetch;
  originalWs = globalThis.WebSocket;
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: "t" }))) as unknown as typeof fetch;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
  // Fast settle check, wide minimum gap: the suite observes resync firing,
  // and only the one-storm test narrows the gap.
  setAttachResyncTimingsForTests(5, 60_000);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
});

const send = (ws: FakeWebSocket, frame: object): void => {
  ws.onmessage?.({ data: JSON.stringify(frame) });
};

/** Replay + one output byte: the base is established and the pane has spoken. */
function establish(ws: FakeWebSocket, term: FakeTerm): void {
  ws.onopen?.();
  send(ws, { type: "replay", data: "screen\r\n" });
  send(ws, { type: "output", data: "x" });
  void term;
}

describe("needsGridResync (pure table)", () => {
  const at = (cols: number, rows: number) => ({ cols, rows });
  it("no replay painted yet, or no bytes since it, is never a resync", () => {
    expect(needsGridResync({ established: null, current: at(90, 30), outputSince: 5, sinceLastResyncMs: 1e9 })).toBe(
      false,
    );
    expect(
      needsGridResync({ established: at(80, 24), current: at(90, 30), outputSince: 0, sinceLastResyncMs: 1e9 }),
    ).toBe(false);
  });
  it("an adopted grid that matches the painted one is not a resync", () => {
    expect(
      needsGridResync({ established: at(80, 24), current: at(80, 24), outputSince: 3, sinceLastResyncMs: 1e9 }),
    ).toBe(false);
  });
  it("mismatch plus bytes is a resync, unless the storm gap says wait", () => {
    expect(
      needsGridResync({ established: at(80, 24), current: at(90, 30), outputSince: 3, sinceLastResyncMs: 1e9 }),
    ).toBe(true);
    expect(
      needsGridResync({ established: at(80, 24), current: at(90, 30), outputSince: 3, sinceLastResyncMs: 10 }),
    ).toBe(false);
  });
});

describe("useSubshellWs grid resync", () => {
  it("re-attaches once when the client adopts a different grid after pane bytes", async () => {
    const term = fakeTerminal();
    renderHook(() => useSubshellWs({ current: term as unknown as Terminal }, "s-resync", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    establish(instances[0], term);

    // The pane grew: the announcement lands and the pinned container (and
    // with it the terminal grid) adopts it in the same tick.
    term.cols = 90;
    term.rows = 30;
    send(instances[0], { type: "geometry", cols: 90, rows: 30 });

    await waitFor(() => expect(instances.length).toBe(2));
    // One-shot: without a fresh replay establishing a new base, later bytes
    // and even another announcement cannot stack a second resync.
    send(instances[1], { type: "output", data: "y" });
    send(instances[1], { type: "geometry", cols: 100, rows: 40 });
    term.cols = 100;
    term.rows = 40;
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(instances.length).toBe(2);
  });

  it("a LATE adoption still resyncs, not just one that beats the settle check", async () => {
    // The announced grid is adopted asynchronously (container → letterbox →
    // fit). If that settles AFTER the debounced check ran, nothing else would
    // re-ask: the geometry frame is gone and the mismatch just sits there.
    // The terminal's own resize event is the fact that adoption happened, so
    // it drives a fresh check.
    setAttachResyncTimingsForTests(40, 60_000);
    const term = fakeTerminal();
    renderHook(() => useSubshellWs({ current: term as unknown as Terminal }, "s-late-adopt", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    establish(instances[0], term);
    send(instances[0], { type: "geometry", cols: 90, rows: 30 });
    await new Promise<void>((r) => setTimeout(r, 150)); // the settle check ran, on the OLD grid
    expect(instances.length).toBe(1);
    term.cols = 90; // …and the grid lands late, through the terminal's own resize
    term.rows = 30;
    for (const h of term.resizeHandlers ?? []) h({ cols: 90, rows: 30 }); // drive onResize subscribers
    await waitFor(() => expect(instances.length).toBe(2));
  });

  it("adopts a grid change in silence with no bytes to misplace", async () => {
    const term = fakeTerminal();
    renderHook(() => useSubshellWs({ current: term as unknown as Terminal }, "s-idle-resize", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    instances[0].onopen?.();
    send(instances[0], { type: "replay", data: "screen\r\n" }); // established, zero output since

    term.cols = 90;
    term.rows = 30;
    send(instances[0], { type: "geometry", cols: 90, rows: 30 });
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(instances.length).toBe(1); // no reconnect
  });

  it("an announcement that matches the painted grid changes nothing", async () => {
    const term = fakeTerminal();
    renderHook(() => useSubshellWs({ current: term as unknown as Terminal }, "s-same-grid", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    establish(instances[0], term);
    send(instances[0], { type: "geometry", cols: term.cols, rows: term.rows });
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(instances.length).toBe(1);
  });

  it("a bouncing grid resyncs at most once per storm gap", async () => {
    setAttachResyncTimingsForTests(2, 10_000); // wide gap, fast settle check
    const term = fakeTerminal();
    renderHook(() => useSubshellWs({ current: term as unknown as Terminal }, "s-storm", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    establish(instances[0], term);
    term.cols = 90;
    term.rows = 30;
    send(instances[0], { type: "geometry", cols: 90, rows: 30 });
    await waitFor(() => expect(instances.length).toBe(2));

    // Immediately bounce it again: the new socket has no replay yet, so the
    // gap guard is belt-and-braces on top of the one-shot rule.
    send(instances[1], { type: "replay", data: "screen2\r\n" });
    send(instances[1], { type: "output", data: "z" });
    term.cols = 60;
    term.rows = 20;
    send(instances[1], { type: "geometry", cols: 60, rows: 20 });
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(instances.length).toBe(2); // gap still open: no third connect
  });
});
