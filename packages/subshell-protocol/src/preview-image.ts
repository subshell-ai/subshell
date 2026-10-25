import { PREVIEW_FRAME_MAX_BYTES } from "./ssh-limits.js";

/** Limits both canvas allocation and decoded screencast images (including 4K). */
export const PREVIEW_IMAGE_MAX_DIMENSION = 8192;
export const PREVIEW_IMAGE_MAX_PIXELS = 16_777_216;

export function previewDimensionsAllowed(w: unknown, h: unknown): boolean {
  return (
    typeof w === "number" &&
    typeof h === "number" &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= PREVIEW_IMAGE_MAX_DIMENSION &&
    h <= PREVIEW_IMAGE_MAX_DIMENSION &&
    w * h <= PREVIEW_IMAGE_MAX_PIXELS
  );
}

/** Check before decoding base64 or allocating an image/canvas. */
export function previewImageSizeAllowed(w: unknown, h: unknown, blob: unknown): boolean {
  return (
    previewDimensionsAllowed(w, h) &&
    typeof blob === "string" &&
    blob.length > 0 &&
    blob.length <= Math.ceil(PREVIEW_FRAME_MAX_BYTES / 3) * 4
  );
}
