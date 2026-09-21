import { describe, expect, it } from "bun:test";
import { CBOR_VALUE, decodeFrame, encodeFrame, parseWireMode, WIRE_MODE_PARAM } from "../wire.js";

/**
 * The `/ws` frame encoder wrapper (spec 2026-09-21 Wave B). Every frame shape
 * on the wire today must survive an encode/decode round trip unchanged, the
 * string side must stay JSON, and repeated encodes of one frame must be
 * byte-identical (the replay path re-encodes the same shapes all day).
 */

const serverFrames: unknown[] = [
  { type: "replay", data: "screen\r\nmore\x1b[31m" },
  { type: "output", data: "chunk" },
  { type: "output" },
  { type: "geometry", cols: 120, rows: 40 },
  {
    type: "viewers",
    you: "v1",
    viewers: [
      {
        id: "v1",
        label: "Laptop",
        capacity: { cols: 120, rows: 40 },
        since: "2026-09-21T00:00:00Z",
        canInput: true,
        hidden: false,
      },
      { id: "v2", label: "Phone", capacity: null, since: "2026-09-21T00:00:01Z", canInput: false, hidden: true },
    ],
    sizing: { mode: "pinned", pinnedViewerId: "v1" },
    inputAcks: true,
  },
  { type: "ack", id: 17 },
];

const clientFrames: unknown[] = [
  { type: "input", data: "ls\r" },
  { type: "input", data: "x", id: 1 },
  { type: "input", data: "" },
  { type: "resize", cols: 80, rows: 24 },
  { type: "visibility", hidden: true },
  { type: "set-sizing", mode: "auto", viewerId: null },
];

describe("encodeFrame/decodeFrame round trips", () => {
  it("every server frame shape survives the round trip unchanged", () => {
    for (const frame of serverFrames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("every client frame shape survives the round trip unchanged", () => {
    for (const frame of clientFrames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("terminal bytes with escapes and CRLF survive verbatim", () => {
    const data = "\x1b[2J\x1b[Hhéllo\r\nmulti\r\nline";
    const frame = decodeFrame(encodeFrame({ type: "output", data })) as { data: string };
    expect(frame.data).toBe(data);
  });
});

describe("decodeFrame string passthrough", () => {
  it("parses a JSON text frame", () => {
    expect(decodeFrame('{"type":"ack","id":1}')).toEqual({ type: "ack", id: 1 });
  });

  it("throws on a malformed string, so the receiver owns the catch", () => {
    expect(() => decodeFrame("{not json")).toThrow();
  });

  it("throws on malformed bytes, so the receiver owns the catch", () => {
    expect(() => decodeFrame(new Uint8Array([0xff, 0x00]))).toThrow();
  });
});

describe("encodeFrame determinism", () => {
  it("repeated encodes of one frame are byte-identical", () => {
    const frame = serverFrames[4];
    const first = encodeFrame(frame);
    for (let i = 0; i < 3; i++) {
      expect(Buffer.compare(encodeFrame(frame), first)).toBe(0);
    }
  });
});

describe("parseWireMode", () => {
  it("negotiates CBOR only on the exact value", () => {
    expect(parseWireMode(CBOR_VALUE)).toBe("cbor");
  });

  it("anything else is JSON: absent, empty, a typo, an unknown future value", () => {
    expect(parseWireMode(null)).toBe("json");
    expect(parseWireMode(undefined)).toBe("json");
    expect(parseWireMode("")).toBe("json");
    expect(parseWireMode("CBOR")).toBe("json");
    expect(parseWireMode("cborx")).toBe("json");
  });

  it("the parameter name constant is the string the URL carries", () => {
    expect(WIRE_MODE_PARAM).toBe("enc");
  });
});
