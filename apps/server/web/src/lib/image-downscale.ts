/**
 * Client-side image downsizing ahead of a subshell upload.
 *
 * Screenshots arrive as multi-megabyte PNGs at 2×/3× density; pasted into an
 * agent prompt as a PATH, the harness Reads the file and its base64 then rides
 * EVERY subsequent API turn of that conversation — a few full-size captures
 * and the model call balloons to tens of MB and stalls. Claude's vision input
 * itself samples at {@link MAX_EDGE_PX} at most, so bytes beyond that budget
 * buy the agent nothing while costing every turn. Shrinking here keeps the
 * stored file small on local AND node subshells (the node relay ships 512 KiB
 * RPC chunks — one downsized image is typically one chunk).
 *
 * Deliberately conservative: only still raster formats the canvas can decode
 * without losing something structural (GIF animation, SVG vectors, exotic
 * types pass through untouched), and ANY failure in the pipeline uploads the
 * original — this is an optimization, never a new way to lose a file.
 */

/** Max edge (px) kept after downscale — Claude vision's own sampling ceiling. */
export const MAX_EDGE_PX = 1568;
/** Files at or below this size never bother with a decode/re-encode pass. */
export const DOWNSCALE_TRIGGER_BYTES = 1024 * 1024;
/** Encoder quality for lossy formats (PNG stays lossless — screenshots are text). */
export const LOSSY_QUALITY = 0.92;

const DOWNSCALE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** True when `file` is a raster type whose pixels we may reduce. */
export function shouldConsiderDownscale(mime: string, sizeBytes: number): boolean {
  return DOWNSCALE_TYPES.has(mime) && sizeBytes > DOWNSCALE_TRIGGER_BYTES;
}

/**
 * Uniform scale factor to fit the longest edge within {@link MAX_EDGE_PX};
 * 1 means "already fits, leave it alone".
 */
export function scaleForDimensions(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE_PX) return 1;
  return MAX_EDGE_PX / longest;
}

/**
 * Returns a downscaled copy of oversized raster uploads, or the original file
 * when it is small, not a supported still-raster type, or anything in the
 * canvas pipeline fails/produces no byte saving.
 */
export async function prepareForUpload(file: File): Promise<File> {
  if (!shouldConsiderDownscale(file.type, file.size)) return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = scaleForDimensions(bitmap.width, bitmap.height);
    if (scale >= 1) return file;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const blob = await paintToBlob(bitmap, w, h, file.type);
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    // No createImageBitmap/canvas in this environment (older browser, happy-dom
    // test runner), or the decode failed: the original uploads untouched.
    return file;
  } finally {
    bitmap?.close?.();
  }
}

/** Draws the (already measured) target size onto a canvas and encodes it; null when no canvas exists. */
async function paintToBlob(bitmap: ImageBitmap, width: number, height: number, type: string): Promise<Blob | null> {
  const quality = type === "image/png" ? undefined : LOSSY_QUALITY;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality });
  }
  // Safari < 16.4 has no OffscreenCanvas: an HTMLCanvasElement works just as
  // well, with the callback-style toBlob wrapped back into a promise.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}
