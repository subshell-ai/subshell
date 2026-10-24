import { describe, expect, it } from "bun:test";
import { previewJpegAllowed } from "@/lib/preview-jpeg";

const segment = (marker: number, bytes: number[]) => [
  0xff,
  marker,
  (bytes.length + 2) >> 8,
  (bytes.length + 2) & 255,
  ...bytes,
];
const sof = (w: number, h: number) => segment(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
const encode = (bytes: number[]) => Buffer.from(bytes).toString("base64");

describe("preview JPEG allocation bounds", () => {
  it("accepts ordinary dimensions and escaped entropy markers", () => {
    expect(
      previewJpegAllowed(
        encode([
          0xff,
          0xd8,
          ...sof(1920, 1080),
          ...segment(0xda, [1, 1, 0, 0, 63, 0]),
          3,
          0xff,
          0,
          7,
          0xff,
          0xd0,
          0xff,
          0xd9,
        ]),
      ),
    ).toBe(true);
  });
  it("rejects image dimensions independently of the claimed frame metadata", () => {
    for (const [w, h] of [
      [65535, 65535],
      [8192, 8192],
      [0, 100],
    ]) {
      expect(previewJpegAllowed(encode([0xff, 0xd8, ...sof(w, h), 0xff, 0xd9]))).toBe(false);
    }
  });
  it("rejects replacement dimensions, delayed heights and truncated segments", () => {
    for (const tail of [sof(65535, 65535), segment(0xdc, [0xff, 0xff]), [0xff, 0xe0, 0xff, 0xff]]) {
      expect(previewJpegAllowed(encode([0xff, 0xd8, ...sof(10, 10), ...tail, 0xff, 0xd9]))).toBe(false);
    }
  });
  it("refuses malformed and oversized encoded input before image decoding", () => {
    for (const data of ["bad-base64!", "", "A".repeat(400000), encode([0xff, 0xd8, 0xff, 0xd9])]) {
      expect(previewJpegAllowed(data)).toBe(false);
    }
  });
});
