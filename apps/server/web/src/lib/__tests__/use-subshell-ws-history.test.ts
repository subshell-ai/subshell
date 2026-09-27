import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { decodeFrame } from "@internal/subshell-protocol/wire";
import { renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { DEVICE_NAME_KEY } from "@/lib/device-name";
import { useSubshellWs } from "@/lib/use-subshell-ws";

/**
 * The one-shot `history` frame: prior scrollback arrives AFTER the replay and
 * must be written after it (that is what rebuilds the scrollback in place),
 * and must be DROPPED if it ever lands before the first replay of a
 * connection — the replay's `term.reset()` would eat it, and the frame's
 * contract makes absence legal, so dropping is always the right call.
 * The server orders the frames itself (`ws/attach-history.ts` on both attach
 * paths); these cases pin the client's half of that contract.
 */

/** A minimal xterm stand-in; `write` and `reset` are observable. */
function fakeTerminal() {
  const writes: string[] = [];
  const term = {
    options: { disableStdin: false } as { disableStdin: boolean },
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
    reset: () => {
      writes.length = 0; // a reset wipes the screen; the record follows the screen
    },
    write: (s: string) => {
      writes.push(s);
    },
  };
  return { term: term as unknown as Terminal, writes };
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onerror?: () => void;
  /** Per-socket, NOT a module-level list: the document is shared by every
   * suite in the run (see the same note in use-subshell-ws-presence.test.ts). */
  readonly sent: string[] = [];
  constructor(_url: string) {
    instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : JSON.stringify(decodeFrame(data)));
  }
  close(): void {
    this.readyState = 3;
  }
  /** Deliver one server frame to the hook, JSON-spelled like the fake server. */
  give(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
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
  window.localStorage.removeItem(DEVICE_NAME_KEY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
  window.localStorage.removeItem(DEVICE_NAME_KEY);
});

/** Attaches and waits for the socket; returns the socket plus the terminal. */
async function attach() {
  const { term, writes } = fakeTerminal();
  renderHook(() => useSubshellWs({ current: term }, "s1", {}, false));
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return Object.assign(instances[0], { term, writes });
}

describe("useSubshellWs history frame", () => {
  it("writes the history frame after the replay, into the rebuilt screen", async () => {
    const ws = await attach();
    ws.give({ type: "replay", data: "CURRENT-GRID" });
    expect(ws.writes).toEqual(["CURRENT-GRID"]);
    ws.give({ type: "history", data: "PRIOR-OUTPUT" });
    // History lands AFTER the replay: the app's old frames scroll into the
    // scrollback the replay's screen sits above.
    expect(ws.writes).toEqual(["CURRENT-GRID", "PRIOR-OUTPUT"]);
  });

  it("drops a history frame that arrives before the first replay", async () => {
    // The reset the next replay performs would eat any earlier write, and the
    // frame's contract makes absence legal, so the drop loses nothing.
    const ws = await attach();
    ws.give({ type: "history", data: "PRIOR-OUTPUT" });
    expect(ws.writes).toEqual([]);
    ws.give({ type: "replay", data: "CURRENT-GRID" });
    expect(ws.writes).toEqual(["CURRENT-GRID"]);
  });

  it("a history frame with no data writes nothing (an absent window needs no ceremony)", async () => {
    const ws = await attach();
    ws.give({ type: "replay", data: "CURRENT-GRID" });
    ws.give({ type: "history", data: "" });
    expect(ws.writes).toEqual(["CURRENT-GRID"]);
  });
});
