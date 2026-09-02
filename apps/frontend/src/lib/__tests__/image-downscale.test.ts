import { describe, expect, it } from "bun:test";
import {
  DOWNSCALE_TRIGGER_BYTES,
  MAX_EDGE_PX,
  prepareForUpload,
  scaleForDimensions,
  shouldConsiderDownscale,
} from "../image-downscale.js";

describe("shouldConsiderDownscale", () => {
  it("only bothers with decodable still-raster types", () => {
    expect(shouldConsiderDownscale("image/png", DOWNSCALE_TRIGGER_BYTES + 1)).toBe(true);
    expect(shouldConsiderDownscale("image/jpeg", DOWNSCALE_TRIGGER_BYTES + 1)).toBe(true);
    expect(shouldConsiderDownscale("image/webp", DOWNSCALE_TRIGGER_BYTES + 1)).toBe(true);
    expect(shouldConsiderDownscale("image/gif", 50 * 1024 * 1024)).toBe(false); // animation
    expect(shouldConsiderDownscale("image/svg+xml", 5 * 1024 * 1024)).toBe(false); // vector
    expect(shouldConsiderDownscale("application/pdf", 5 * 1024 * 1024)).toBe(false);
  });

  it("small images never enter the pipeline (a decode would gain nothing)", () => {
    expect(shouldConsiderDownscale("image/png", DOWNSCALE_TRIGGER_BYTES)).toBe(false);
  });
});

describe("scaleForDimensions", () => {
  it("leaves images within the vision sampling budget alone", () => {
    expect(scaleForDimensions(1568, 900)).toBe(1);
    expect(scaleForDimensions(900, 1568)).toBe(1);
  });

  it("fits the LONGEST edge to the budget, uniformly", () => {
    expect(scaleForDimensions(3136, 1960)).toBe(0.5); // 3136 → 1568
    expect(scaleForDimensions(2000, 4000)).toBe(MAX_EDGE_PX / 4000);
  });
});

const big = () => new File([new Uint8Array(DOWNSCALE_TRIGGER_BYTES + 10)], "shot.png", { type: "image/png" });

describe("prepareForUpload", () => {
  it("passes small or unsupported files through by identity", async () => {
    const small = new File(["tiny"], "a.png", { type: "image/png" });
    expect(await prepareForUpload(small)).toBe(small);
    const gif = new File([new Uint8Array(2 * 1024 * 1024)], "anim.gif", { type: "image/gif" });
    expect(await prepareForUpload(gif)).toBe(gif);
  });

  it("uploads the ORIGINAL when the browser has no image pipeline (decode failure)", async () => {
    // happy-dom: createImageBitmap does not exist — the conservative path.
    const file = big();
    expect(await prepareForUpload(file)).toBe(file);
  });

  it("returns a downscaled File when the re-encode is smaller than the original", async () => {
    const originals = { bitmap: globalThis.createImageBitmap, off: globalThis.OffscreenCanvas };
    // Stub the canvas pipeline: a 3136×1960 bitmap, encoded to a small blob.
    globalThis.createImageBitmap = (async () => ({
      width: 3136,
      height: 1960,
      close: () => {},
    })) as typeof createImageBitmap;
    class FakeOff {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(1000)], { type: "image/png" });
      }
    }
    globalThis.OffscreenCanvas = FakeOff as unknown as typeof OffscreenCanvas;
    try {
      const file = big();
      const out = await prepareForUpload(file);
      expect(out).not.toBe(file);
      expect(out.name).toBe("shot.png"); // same name, same type, fewer bytes
      expect(out.type).toBe("image/png");
      expect(out.size).toBe(1000);
    } finally {
      globalThis.createImageBitmap = originals.bitmap;
      globalThis.OffscreenCanvas = originals.off;
    }
  });

  it("keeps the original when the canvas would produce NO byte saving", async () => {
    const originals = { bitmap: globalThis.createImageBitmap, off: globalThis.OffscreenCanvas };
    globalThis.createImageBitmap = (async () => ({
      width: 3136,
      height: 1960,
      close: () => {},
    })) as typeof createImageBitmap;
    class FakeOff {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(DOWNSCALE_TRIGGER_BYTES + 10)], { type: "image/png" }); // ≥ original
      }
    }
    globalThis.OffscreenCanvas = FakeOff as unknown as typeof OffscreenCanvas;
    try {
      const file = big();
      expect(await prepareForUpload(file)).toBe(file);
    } finally {
      globalThis.createImageBitmap = originals.bitmap;
      globalThis.OffscreenCanvas = originals.off;
    }
  });

  it("leaves an already-small image untouched even past the size trigger", async () => {
    const originals = { bitmap: globalThis.createImageBitmap };
    globalThis.createImageBitmap = (async () => ({
      width: 1000,
      height: 800,
      close: () => {},
    })) as typeof createImageBitmap;
    try {
      const file = big();
      expect(await prepareForUpload(file)).toBe(file); // scale === 1 ⇒ no re-encode at all
    } finally {
      globalThis.createImageBitmap = originals.bitmap;
    }
  });
});
