import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { decodeFrame } from "@internal/subshell-protocol/wire";
import { renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import {
  attachRetryDelayMs,
  isRetryableAttachClose,
  setAttachRetryDelaysForTests,
  useSubshellWs,
} from "@/lib/use-subshell-ws";

/**
 * Wave D's client half: the 4004 "node offline" close is retryable with an
 * escalating backoff while the terminal is open, every other 4xxx refusal is
 * terminal, and a backlog stranded by the refusal ships on the next
 * successful attach and drains to zero.
 */

/**
 * The close-code table, pinned without a socket. 4004 is the one 4xxx code
 * that can name a transient state ("node offline"); every other refusal
 * terminal exactly as before; sub-4000 drops and restarts retry as always.
 */
describe("attach close-code policy", () => {
  it("4004 retries; every other 4xxx refusal in the table is terminal", () => {
    expect(isRetryableAttachClose(4004)).toBe(true);
    for (const code of [4000, 4001, 4002, 4003, 4005, 4010, 4406, 4999]) {
      expect(isRetryableAttachClose(code)).toBe(false);
    }
    // 4005 "subshell not found" is the permanent refusal the server split
    // out of 4004 (Wave D review): retrying can never make a subshell exist.
  });

  it("sub-4000 closes retry, exactly as they always did", () => {
    for (const code of [1000, 1006, 1011, 1012]) {
      expect(isRetryableAttachClose(code)).toBe(true);
    }
  });
});

describe("attach retry backoff", () => {
  it("escalates from one base interval and caps", () => {
    // Restored for the assertions below; the hook tests set their own.
    setAttachRetryDelaysForTests(1500, 15000);
    expect(attachRetryDelayMs(1)).toBe(1500);
    expect(attachRetryDelayMs(2)).toBe(3000);
    expect(attachRetryDelayMs(3)).toBe(6000);
    expect(attachRetryDelayMs(4)).toBe(12000);
    expect(attachRetryDelayMs(5)).toBe(15000);
    expect(attachRetryDelayMs(50)).toBe(15000); // capped, never more
  });
});

/** A minimal xterm stand-in — see use-subshell-ws-readonly.test.ts. */
function fakeTerminal() {
  const term = {
    options: { disableStdin: false } as { disableStdin: boolean },
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
    reset: () => {},
    write: () => {},
  };
  return term as unknown as Terminal;
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
  readonly sent: Array<string | Uint8Array> = [];
  constructor(url: string) {
    urls.push(url);
    instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) =>
      typeof raw === "string"
        ? (JSON.parse(raw) as Record<string, unknown>)
        : (decodeFrame(raw) as Record<string, unknown>),
    );
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
  // Millisecond retries: the tests observe several attempts land, and a
  // second's wait per attempt would make the suite crawl.
  setAttachRetryDelaysForTests(1, 4);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
});

/** The server frame that both engages input acks and proves the attach is
 * serving frames (the queue's resend waits for the first server frame). */
const viewersFrame = JSON.stringify({
  type: "viewers",
  you: "v1",
  viewers: [],
  sizing: { mode: "auto", pinnedViewerId: null },
  inputAcks: true,
});

describe("useSubshellWs close handling (Wave D)", () => {
  it("retries a 4004 node-offline close, and keeps retrying", async () => {
    const closes: number[] = [];
    renderHook(() => useSubshellWs({ current: fakeTerminal() }, "s-retry", { onClose: (code) => closes.push(code) }));
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    instances[0].onclose?.({ code: 4004, reason: "node offline" });
    expect(closes).toEqual([4004]); // the page still learns the refusal
    await waitFor(() => expect(instances.length).toBe(2));
    instances[1].onclose?.({ code: 4004, reason: "node offline" });
    await waitFor(() => expect(instances.length).toBe(3)); // bounded, not one-shot
  });

  it("a terminal refusal code never schedules a retry", async () => {
    renderHook(() => useSubshellWs({ current: fakeTerminal() }, "s-terminal", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    instances[0].onclose?.({ code: 4001, reason: "unauthorized" });
    // Long past the (1 ms) retry delay a 4004 would have fired by now.
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(instances.length).toBe(1);
  });

  it("a backlog stranded by a 4004 refusal ships on the next attach and drains to zero", async () => {
    const { result } = renderHook(() => useSubshellWs({ current: fakeTerminal() }, "s-backlog", {}));
    await waitFor(() => expect(instances.length).toBe(1));
    const [ws1] = instances;
    ws1.onopen?.();
    ws1.onmessage?.({ data: viewersFrame });
    const queue = result.current.inputQueueRef.current;
    expect(queue).not.toBeNull();
    // Typed while the node was going down: id 1 left the wire, id 2 COALESCED
    // behind it (the pipe is behind while a frame is unacked) — this is the
    // stranded state, exactly.
    queue?.enqueue("a");
    queue?.enqueue("b");
    expect(ws1.frames().filter((f) => f.type === "input")).toEqual([{ type: "input", data: "a", id: 1 }]);
    expect(queue?.stats.depth).toBe(2);
    expect(queue?.stats.backlog).toBe(1);

    // The refusal, and the retry it now earns.
    ws1.onclose?.({ code: 4004, reason: "node offline" });
    await waitFor(() => expect(instances.length).toBe(2));
    const ws2 = instances[1];
    ws2.onopen?.();
    ws2.onmessage?.({ data: viewersFrame });
    // The fresh attach's first server frame ships the whole backlog, in id
    // order, ids unchanged.
    expect(ws2.frames().filter((f) => f.type === "input")).toEqual([
      { type: "input", data: "a", id: 1 },
      { type: "input", data: "b", id: 2 },
    ]);
    // The plane acks (its Wave D hold re-fired the writes): the queue empties.
    ws2.onmessage?.({ data: JSON.stringify({ type: "ack", id: 1 }) });
    ws2.onmessage?.({ data: JSON.stringify({ type: "ack", id: 2 }) });
    expect(queue?.stats.depth).toBe(0);
  });
});
