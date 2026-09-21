import { describe, expect, it } from "bun:test";
import { decodeFrame, encodeFrame } from "@internal/subshell-protocol/wire";
import {
  broadcastToViewers,
  broadcastViewers,
  encodeForSocket,
  registerViewer,
  resetLiveViewersForTests,
  sendFrame,
  type WsSocket,
} from "@/ws/viewers.js";
import { decodeIncoming } from "@/ws/wire.js";

/**
 * The negotiated `/ws` wire (spec 2026-09-21 Wave B). The un-negotiated mode
 * is the golden one: its bytes must be EXACTLY what the wire carried before
 * the negotiation existed, because a cached PWA never negotiates and every
 * older client renders from today's JSON. The negotiated mode must round
 * trip, and a pane whose viewers are in BOTH modes at once (a tab beside a
 * cached PWA) must deliver each mode its own payload.
 */

/** A socket recording exactly what it was handed, string or bytes. */
function fakeSocket(wireMode?: "json" | "cbor", viewerId = crypto.randomUUID()) {
  const sent: Array<string | Uint8Array> = [];
  const ws = {
    data: {
      launcher: {},
      socket: "sock",
      subshellId: "s-wire",
      logFile: "/dev/null",
      canInput: true,
      viewerId,
      deviceLabel: "Test device",
      since: new Date().toISOString(),
      ...(wireMode ? { wireMode } : {}),
    },
    send: (raw: string | Uint8Array) => {
      sent.push(raw);
    },
    close: () => undefined,
  } as unknown as WsSocket;
  return { ws, sent, viewerId };
}

/** The frames a socket received, all decoded to objects. */
const decoded = (sent: Array<string | Uint8Array>) =>
  sent.map((raw) => (typeof raw === "string" ? (JSON.parse(raw) as object) : (decodeFrame(raw) as object)));

describe("encodeForSocket / sendFrame", () => {
  it("an un-negotiated socket receives the EXACT JSON bytes the wire always carried", () => {
    // Golden byte-identity: JSON.stringify output, not a reimplementation of
    // it. The negotiation promises this mode is untouched.
    const frame = { type: "ack", id: 3 };
    const { ws, sent } = fakeSocket();
    sendFrame(ws, frame);
    expect(sent).toEqual([JSON.stringify(frame)]);
  });

  it("an un-negotiated socket with the mode spelled explicitly receives the same bytes", () => {
    const { ws, sent } = fakeSocket("json");
    sendFrame(ws, { type: "output", data: "hi" });
    expect(sent).toEqual([JSON.stringify({ type: "output", data: "hi" })]);
  });

  it("a negotiated socket receives CBOR bytes that decode to the frame", () => {
    const frame = { type: "replay", data: "SCREEN\r\n" };
    const { ws, sent } = fakeSocket("cbor");
    sendFrame(ws, frame);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(Uint8Array);
    expect(decoded(sent)).toEqual([frame]);
    // And those bytes are what the protocol's encoder produces: one decision,
    // one spelling.
    expect(sent[0]).toEqual(encodeFrame(frame));
  });

  it("encodeForSocket is the single decision, for direct call sites too", () => {
    const frame = { type: "geometry", cols: 80, rows: 24 };
    expect(encodeForSocket(fakeSocket().ws, frame)).toBe(JSON.stringify(frame));
    expect(encodeForSocket(fakeSocket("cbor").ws, frame)).toEqual(encodeFrame(frame));
  });

  it("a send error is absorbed, as every send site here already did", () => {
    const { ws } = fakeSocket("cbor");
    ws.send = () => {
      throw new Error("socket gone");
    };
    expect(() => sendFrame(ws, { type: "ack", id: 1 })).not.toThrow();
  });
});

describe("broadcastToViewers across modes", () => {
  it("a mixed audience gets each mode its own payload", () => {
    resetLiveViewersForTests();
    const json = fakeSocket();
    const cbor = fakeSocket("cbor");
    registerViewer(json.ws, "s-wire");
    registerViewer(cbor.ws, "s-wire");
    broadcastToViewers("s-wire", { type: "geometry", cols: 100, rows: 30 });
    expect(json.sent).toEqual([JSON.stringify({ type: "geometry", cols: 100, rows: 30 })]);
    expect(cbor.sent[0]).toBeInstanceOf(Uint8Array);
    expect(decoded(cbor.sent)).toEqual([{ type: "geometry", cols: 100, rows: 30 }]);
    resetLiveViewersForTests();
  });

  it("a same-mode audience is encoded once", () => {
    resetLiveViewersForTests();
    const a = fakeSocket("cbor", crypto.randomUUID());
    const b = fakeSocket("cbor", crypto.randomUUID());
    registerViewer(a.ws, "s-wire");
    registerViewer(b.ws, "s-wire");
    broadcastToViewers("s-wire", { type: "output", data: "x" });
    // One shared payload, byte-identical on both sockets: encode-once
    // economics preserved from the old single-string version.
    expect(a.sent[0]).toEqual(b.sent[0]);
    resetLiveViewersForTests();
  });
});

describe("broadcastViewers across modes", () => {
  it("each recipient gets its own `you` and its own encoding", () => {
    resetLiveViewersForTests();
    const json = fakeSocket();
    const cbor = fakeSocket("cbor");
    registerViewer(json.ws, "s-wire");
    registerViewer(cbor.ws, "s-wire");
    broadcastViewers("s-wire");
    const [jsonFrame] = decoded(json.sent) as Array<Record<string, unknown>>;
    expect(jsonFrame.you).toBe(json.viewerId);
    expect(jsonFrame.inputAcks).toBe(true);
    const [cborFrame] = decoded(cbor.sent) as Array<Record<string, unknown>>;
    expect(cborFrame.you).toBe(cbor.viewerId);
    resetLiveViewersForTests();
  });
});

describe("decodeIncoming", () => {
  it("decodes CBOR bytes", () => {
    expect(decodeIncoming(encodeFrame({ type: "input", data: "ls\r", id: 1 }))).toEqual({
      type: "input",
      data: "ls\r",
      id: 1,
    });
  });

  it("decodes a raw ArrayBuffer the way a server adapter may hand binary over", () => {
    const bytes = encodeFrame({ type: "resize", cols: 80, rows: 24 });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decodeIncoming(buffer)).toEqual({ type: "resize", cols: 80, rows: 24 });
  });

  it("malformed bytes become null, which the dispatcher drops", () => {
    expect(decodeIncoming(new Uint8Array([0xff, 0x00]))).toBeNull();
  });

  it("strings and Elysia's pre-parsed objects pass through untouched", () => {
    const raw = JSON.stringify({ type: "visibility", hidden: false });
    expect(decodeIncoming(raw)).toBe(raw);
    const parsed = { type: "visibility", hidden: false };
    expect(decodeIncoming(parsed)).toBe(parsed);
  });
});
