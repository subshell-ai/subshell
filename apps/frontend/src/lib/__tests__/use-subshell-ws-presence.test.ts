import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { DEVICE_NAME_KEY } from "@/lib/device-name";
import { useSubshellWs, type ViewersState } from "@/lib/use-subshell-ws";

/**
 * The multi-device half of the attach: naming this device on the connect URL,
 * reporting whether it is being rendered, and surfacing the viewer list.
 */

/** A minimal xterm stand-in — see use-subshell-ws-readonly.test.ts. */
function fakeTerminal() {
  const term = {
    options: { disableStdin: false } as { disableStdin: boolean },
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: () => {} }),
    onResize: (cb: (size: { cols: number; rows: number }) => void) => {
      term._onResize = cb;
      return { dispose: () => {} };
    },
    _onResize: undefined as ((size: { cols: number; rows: number }) => void) | undefined,
    reset: () => {},
    write: () => {},
  };
  return term as unknown as Terminal & { _onResize?: (size: { cols: number; rows: number }) => void };
}

const urls: string[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onerror?: () => void;
  /**
   * Per-socket, NOT a module-level list. `visibilitychange` is a DOCUMENT
   * event and the document is shared by every suite in the run, so a global
   * sink also counts frames from another test file's still-mounted hook —
   * this file passed alone and failed in the full suite until the sink became
   * per-socket.
   */
  readonly sent: string[] = [];
  constructor(url: string) {
    urls.push(url);
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  /** The frames this socket was given, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((f) => JSON.parse(f));
  }
}
const instances: FakeWebSocket[] = [];

let originalFetch: typeof fetch;
let originalWs: typeof globalThis.WebSocket;

beforeEach(() => {
  urls.length = 0;
  instances.length = 0;
  originalFetch = globalThis.fetch;
  originalWs = globalThis.WebSocket;
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: "t" }))) as unknown as typeof fetch;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
  window.localStorage.removeItem(DEVICE_NAME_KEY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
  window.localStorage.removeItem(DEVICE_NAME_KEY);
});

/** Attaches and waits for the socket, returning it plus the fake terminal. */
async function attach(
  handlers: Parameters<typeof useSubshellWs>[2] = {},
  capacity?: () => { cols: number; rows: number } | null,
) {
  const term = fakeTerminal();
  renderHook(() => useSubshellWs({ current: term }, "s1", handlers, false, undefined, capacity));
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return Object.assign(instances[0], { term });
}

describe("useSubshellWs presence", () => {
  it("names this device on the connect URL", async () => {
    // Without it every row of everyone else's Devices list reads "Unnamed
    // device", which is worse than no list: two identical rows cannot be told
    // apart, so neither the pane's size nor the pin control means anything.
    // The module existed and was simply never wired up (found live, 2026-09-04).
    window.localStorage.setItem(DEVICE_NAME_KEY, "Kitchen iPad");
    await attach();
    expect(new URL(urls[0]).searchParams.get("device")).toBe("Kitchen iPad");
  });

  it("still names a device that has never been renamed", async () => {
    await attach();
    expect(new URL(urls[0]).searchParams.get("device")).toBeTruthy();
  });

  it("declares whether it is being rendered as soon as the socket opens", async () => {
    // State, not an event: a tab attached while already hidden must say so, or
    // it silently holds every other device's pane at its own size.
    const ws = await attach();
    ws.onopen?.();
    expect(ws.frames().find((f) => f.type === "visibility")).toEqual({
      type: "visibility",
      hidden: document.hidden,
    });
  });

  it("re-declares visibility when the tab is backgrounded", async () => {
    const ws = await attach();
    ws.onopen?.();
    ws.sent.length = 0;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ws.frames().filter((f) => f.type === "visibility")).toHaveLength(1);
  });

  it("hands the viewer list straight to the caller", async () => {
    const seen: ViewersState[] = [];
    const ws = await attach({ onViewers: (s) => seen.push(s) });
    ws.onmessage?.({
      data: JSON.stringify({
        type: "viewers",
        you: "a",
        viewers: [
          { id: "a", label: "Laptop", capacity: { cols: 120, rows: 40 }, since: "t", canInput: true, hidden: false },
        ],
        sizing: { mode: "auto", pinnedViewerId: null },
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].you).toBe("a");
    expect(seen[0].viewers[0].label).toBe("Laptop");
  });

  it("ignores a viewers frame when the caller wants no device UI", async () => {
    const ws = await attach();
    expect(() =>
      ws.onmessage?.({
        data: JSON.stringify({
          type: "viewers",
          you: "a",
          viewers: [],
          sizing: { mode: "auto", pinnedViewerId: null },
        }),
      }),
    ).not.toThrow();
  });
});

describe("useSubshellWs capacity reporting", () => {
  it("reports the VIEWPORT's capacity on a terminal resize, not the terminal's grid", async () => {
    // A pinning caller sizes its container to the grid the server announced,
    // so the terminal resizes to the server's own answer. Forwarding that
    // back reports the server's number as this viewer's capacity — harmless
    // alone, fatal with two viewers: measured live (2026-09-04) a 77x29
    // laptop claimed 50x18 seconds after a 50x18 phone attached, and the pane
    // never grew back when the phone left.
    const ws = await attach({}, () => ({ cols: 77, rows: 29 }));
    ws.sent.length = 0;
    ws.term._onResize?.({ cols: 50, rows: 18 }); // the echo of the pane's grid
    expect(ws.frames()).toEqual([{ type: "resize", cols: 77, rows: 29 }]);
  });

  it("still forwards the terminal's own grid for a caller that does not pin", async () => {
    // Remote panes have no readback to pin to, so the terminal's grid IS the
    // viewport there — the pre-pinning behavior must survive untouched.
    const ws = await attach();
    ws.sent.length = 0;
    ws.term._onResize?.({ cols: 50, rows: 18 });
    expect(ws.frames()).toEqual([{ type: "resize", cols: 50, rows: 18 }]);
  });
});
