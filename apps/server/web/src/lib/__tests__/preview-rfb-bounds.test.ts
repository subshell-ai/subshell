import { describe, expect, it } from "bun:test";
import { rfbImageAllowed } from "@/lib/preview-rfb-bounds";

function png(w: number, h: number, extra = "") {
  const chunk = (name: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(name, 4);
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(extra ? [chunk(extra, Buffer.alloc(0))] : []),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("RFB encoded images", () => {
  it("accepts a bounded static PNG header", () => {
    expect(rfbImageAllowed("image/png", png(1280, 800))).toBe(true);
  });
  it("rejects huge dimensions, animation, duplicate headers and malformed chunks before decoding", () => {
    for (const data of [
      png(65535, 65535),
      png(0, 20),
      png(8192, 8192),
      png(10, 10, "acTL"),
      png(10, 10, "fcTL"),
      png(10, 10, "IHDR"),
      png(10, 10).subarray(0, 32),
    ]) {
      expect(rfbImageAllowed("image/png", data)).toBe(false);
    }
    const data = png(10, 10);
    data.writeUInt32BE(0xffffffff, 8);
    expect(rfbImageAllowed("image/png", data)).toBe(false);
    expect(rfbImageAllowed("image/svg+xml", png(10, 10))).toBe(false);
    expect(rfbImageAllowed("image/jpeg", new Uint8Array(4 * 1024 * 1024 + 1))).toBe(false);
  });
});
