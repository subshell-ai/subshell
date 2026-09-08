import { describe, expect, test } from "bun:test";
import { buildIco } from "../ico";

const png16 = Buffer.alloc(8, 1); // payload content irrelevant; only framing is tested
const png32 = Buffer.alloc(12, 2);

// Layout: 6-byte header, then 16-byte directory entries (dir fields start at byte 6),
// then PNG payloads. Entry0 dir: width@6 height@7 planes@10 bpp@12 size@14 offset@18.
describe("buildIco", () => {
  test("header counts images and directory offsets are correct", () => {
    const ico = buildIco([
      { size: 16, png: png16 },
      { size: 32, png: png32 },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(2); // count
    expect(ico[6]).toBe(16); // entry0 width
    expect(ico[7]).toBe(16); // entry0 height
    expect(ico.readUInt16LE(10)).toBe(1); // entry0 planes
    expect(ico.readUInt16LE(12)).toBe(32); // entry0 bpp
    expect(ico.readUInt32LE(14)).toBe(8); // entry0 payload size
    expect(ico.readUInt32LE(18)).toBe(6 + 32); // entry0 offset = header + 2 directory entries
    expect(ico[22]).toBe(32); // entry1 width
    expect(ico.readUInt32LE(30)).toBe(12); // entry1 payload size
    expect(ico.readUInt32LE(34)).toBe(6 + 32 + 8); // entry1 offset = ... + entry0 payload
    expect(ico.subarray(46, 58)).toEqual(png32);
    expect(ico.length).toBe(6 + 32 + 8 + 12);
  });

  test("256px encodes as 0 bytes", () => {
    const ico = buildIco([{ size: 256, png: png16 }]);
    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
  });
});
