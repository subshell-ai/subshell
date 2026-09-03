import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { useSubshellWs } from "@/lib/use-subshell-ws";

/**
 * Read-only attach for `view` grantees (spec §4.1). The hook both flips xterm's
 * `disableStdin` and guards its own input handler, so a viewer's keystrokes
 * never reach the socket — while the socket still opens (output must stream).
 */

/** A minimal xterm stand-in: records the input callback + the flags the hook sets. */
function fakeTerminal() {
  const term = {
    options: { disableStdin: false } as { disableStdin: boolean },
    cols: 80,
    rows: 24,
    onData: (cb: (d: string) => void) => {
      term._onData = cb;
      return { dispose: () => {} };
    },
    onResize: () => ({ dispose: () => {} }),
    reset: () => {},
    write: () => {},
    _onData: undefined as ((d: string) => void) | undefined,
  };
  return term as unknown as Terminal & { _onData?: (d: string) => void };
}

const sent: string[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(_url: string) {
    instances.push(this);
  }
  send(data: string): void {
    sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}
const instances: FakeWebSocket[] = [];

let originalFetch: typeof fetch;
let originalWs: typeof globalThis.WebSocket;

beforeEach(() => {
  sent.length = 0;
  instances.length = 0;
  originalFetch = globalThis.fetch;
  originalWs = globalThis.WebSocket;
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: "t" }))) as unknown as typeof fetch;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
});

async function attach(readOnly: boolean) {
  const term = fakeTerminal();
  const { result } = renderHook(() => useSubshellWs({ current: term }, "s1", {}, readOnly));
  // connect() is async (it awaits the ws-token call); wait until the socket exists.
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return { term, wsRef: result.current };
}

describe("useSubshellWs read-only attach", () => {
  it("sets disableStdin and drops keystrokes for a viewer", async () => {
    const { term } = await attach(true);
    expect(term.options.disableStdin).toBe(true);
    term._onData?.("ls\r");
    expect(sent).toEqual([]); // nothing forwarded
  });

  it("leaves stdin live and forwards keystrokes for an editor/owner", async () => {
    const { term } = await attach(false);
    expect(term.options.disableStdin).toBe(false);
    term._onData?.("ls\r");
    expect(sent.some((f) => f.includes('"input"'))).toBe(true);
  });
});
