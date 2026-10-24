import { previewDimensionsAllowed, previewImageSizeAllowed } from "@internal/subshell-protocol";

/** Inspect JPEG dimensions before giving untrusted compressed bytes to Image. */
export function previewJpegAllowed(blob: string): boolean {
  if (!previewImageSizeAllowed(1, 1, blob)) return false;
  let data: string;
  try {
    data = atob(blob);
  } catch {
    return false;
  }
  return jpegDimensionsAllowed(data);
}

/** Raw RFB image payloads are bounded separately from base64 CDP frames. */
export function jpegDimensionsAllowed(
  data: string | Uint8Array,
  expected?: { width: number; height: number },
): boolean {
  const byte = (i: number) => (typeof data === "string" ? data.charCodeAt(i) : (data[i] ?? Number.NaN));
  if (byte(0) !== 0xff || byte(1) !== 0xd8) return false;
  let position = 2;
  let entropy = false;
  let hasFrame = false;
  while (position < data.length) {
    if (entropy) {
      while (position < data.length && byte(position) !== 0xff) position++;
    }
    if (byte(position++) !== 0xff) return false;
    while (byte(position) === 0xff) position++;
    const marker = byte(position++);
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    entropy = false;
    if (marker === 0xd9) return hasFrame;
    // Reject a second image and delayed-height JPEGs. CDP emits baseline or
    // progressive JPEGs with dimensions known before compressed scan data.
    if (marker === 0xd8 || marker === 0xdc || marker === 0 || !Number.isFinite(marker)) return false;
    if (marker === 1) continue;
    const length = byte(position) * 256 + byte(position + 1);
    if (!Number.isFinite(length) || length < 2 || position + length > data.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || hasFrame || length < 8) return false;
      const height = byte(position + 3) * 256 + byte(position + 4);
      const width = byte(position + 5) * 256 + byte(position + 6);
      if (!previewDimensionsAllowed(width, height)) return false;
      if (expected && (width !== expected.width || height !== expected.height)) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame) return false;
      entropy = true;
    }
    position += length;
  }
  return false;
}
