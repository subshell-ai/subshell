import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { decodeFrame, encodeFrame } from "@internal/subshell-protocol/wire";
import { renderHook, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { useSubshellWs } from "@/lib/use-subshell-ws";

/**
 * The CBOR wire negotiation (spec 2026-09-21 Wave B), from the client side:
 * the attach URL must ask for it, the socket must read binary frames, and
 * everything the page sends must be CBOR bytes that decode to the frame. The
 * send-decision itself (per-socket mark, JSON fallback for an unmarked
 * socket) is pinned in subshell-frames tests; these cover the hook wiring.
 */

/** A minimal xterm stand-in, matching the other hook tests. */
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

/** Records sends RAW (string or bytes), unlike the normalizing fakes elsewhere. */
class RawFakeWebSocket {
  static readonly OPEN = 1;
  readyState = RawFakeWebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = "blob";
  onopen?: () => void;
  onmessage?: (e: { data: string | ArrayBuffer }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onerror?: () => void;
  url: string;
  readonly rawSends: Array<string | Uint8Array> = [];
  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.rawSends.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}
const instances: RawFakeWebSocket[] = [];

let originalFetch: typeof fetch;
let originalWs: typeof globalThis.WebSocket;

beforeEach(() => {
  instances.length = 0;
  originalFetch = globalThis.fetch;
  originalWs = globalThis.WebSocket;
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: "t" }))) as unknown as typeof fetch;
  globalThis.WebSocket = RawFakeWebSocket as unknown as typeof globalThis.WebSocket;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
});

async function attach(handlers: Parameters<typeof useSubshellWs>[2] = {}) {
  const term = fakeTerminal();
  renderHook(() => useSubshellWs({ current: term }, "s1", handlers));
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return Object.assign(instances[0], { term });
}

describe("useSubshellWs CBOR negotiation", () => {
  it("asks for CBOR on the attach URL and reads binary frames", async () => {
    const ws = await attach();
    expect(new URL(ws.url).searchParams.get("enc")).toBe("cbor");
    // Blobs would force an async read before decode; the decoder wants bytes.
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("reads binary frames as CBOR and serves them to the handlers", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ws = await attach({
      onViewers: (s) => seen.push(s as unknown as Record<string, unknown>),
    });
    const bytes = encodeFrame({
      type: "viewers",
      you: "v1",
      viewers: [],
      sizing: { mode: "auto", pinnedViewerId: null },
      inputAcks: true,
    });
    ws.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    expect(seen).toHaveLength(1);
    expect(seen[0].you).toBe("v1");
  });

  it("still reads a JSON string frame, the older server's answer", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ws = await attach({ onViewers: (s) => seen.push(s as unknown as Record<string, unknown>) });
    ws.onmessage?.({
      data: JSON.stringify({ type: "viewers", you: "v2", viewers: [], sizing: { mode: "auto", pinnedViewerId: null } }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].you).toBe("v2");
  });

  it("sends every frame as CBOR bytes, decodable to the frame it meant", async () => {
    const ws = await attach();
    ws.binaryType = "arraybuffer";
    ws.term._onResize?.({ cols: 90, rows: 30 });
    expect(ws.rawSends).toHaveLength(1);
    const sent = ws.rawSends[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(decodeFrame(sent as Uint8Array)).toEqual({ type: "resize", cols: 90, rows: 30 });
  });

  it("ignores a malformed binary frame instead of throwing", async () => {
    const ws = await attach();
    expect(() => ws.onmessage?.({ data: new Uint8Array([0xff, 0x00]).buffer })).not.toThrow();
  });
});
