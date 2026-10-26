import { PREVIEW_IMAGE_MAX_PIXELS, previewDimensionsAllowed } from "@internal/subshell-protocol";
import type RFB from "@novnc/novnc";
import { jpegDimensionsAllowed } from "./preview-jpeg";

const IMAGE_BYTES_MAX = 4 * 1024 * 1024;

export function rfbImageAllowed(
  mime: string,
  bytes: Uint8Array,
  expected?: { width: number; height: number },
): boolean {
  if (bytes.length > IMAGE_BYTES_MAX) return false;
  if (mime === "image/jpeg") return jpegDimensionsAllowed(bytes, expected);
  if (mime !== "image/png" || bytes.length < 33) return false;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 8;
  let header = false;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position);
    if (position + length + 12 > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(position + 4, position + 8));
    if (type === "IHDR") {
      if (header || position !== 8 || length !== 13) return false;
      if (!previewDimensionsAllowed(view.getUint32(position + 8), view.getUint32(position + 12))) return false;
      if (
        expected &&
        (view.getUint32(position + 8) !== expected.width || view.getUint32(position + 12) !== expected.height)
      )
        return false;
      header = true;
    } else if (!header || type === "acTL" || type === "fcTL") return false;
    if (type === "IEND") return length === 0;
    position += length + 12;
  }
  return false;
}

/** Private noVNC 1.7 surface, pinned by the real-class regression. */
interface BoundedRfb {
  _FBU: { width: number; height: number; encoding: number };
  _resize(width: number, height: number): void;
  _handleRect(): boolean;
  _fail(message: string): false;
  _handleServerCutText(): boolean;
  _sock: {
    rQwait(label: string, length: number, backtrack?: number): boolean;
    rQskipBytes(length: number): void;
    rQshift32(): number;
  };
  _display: {
    _renderQ: { width?: number; height?: number }[];
    imageRect(x: number, y: number, w: number, h: number, mime: string, bytes: Uint8Array): void;
  };
}

/** Install before the socket's first event, bounding both canvas and decoder inputs. */
export function installRfbBounds(instance: RFB): void {
  const rfb = instance as unknown as BoundedRfb;
  let failed = false;
  const reject = (message: string): false => {
    failed = true;
    return rfb._fail(message);
  };
  const resize = rfb._resize.bind(rfb);
  const rect = rfb._handleRect.bind(rfb);
  const image = rfb._display.imageRect.bind(rfb._display);
  rfb._resize = (width, height) => {
    if (failed) return;
    if (!previewDimensionsAllowed(width, height)) {
      reject("Screen dimensions exceed the preview limit");
      return;
    }
    resize(width, height);
  };
  rfb._handleRect = () => {
    if (failed) return false;
    const { width, height, encoding } = rfb._FBU;
    const queued = rfb._display._renderQ;
    const pixels = queued.reduce((sum, action) => sum + (action.width ?? 0) * (action.height ?? 0), 0);
    if (queued.length >= 1024 || pixels + width * height > 2 * PREVIEW_IMAGE_MAX_PIXELS) {
      return reject("Screen updates exceeded the pending render budget");
    }
    // Empty rectangles carry pseudo-encoding signals. Nonempty cursor and
    // data rectangles must fit the same pixel budget as the framebuffer.
    // x11vnc does not use H.264; reject that optional video-decoder path.
    if (encoding === 50 || (width !== 0 && height !== 0 && !previewDimensionsAllowed(width, height))) {
      return reject("Screen update exceeds the preview limit");
    }
    return rect();
  };
  rfb._display.imageRect = (x, y, w, h, mime, bytes) => {
    if (failed) return;
    if (!previewDimensionsAllowed(w, h) || !rfbImageAllowed(mime, bytes, { width: w, height: h })) {
      reject("Screen image exceeds the preview limit");
      return;
    }
    image(x, y, w, h, mime, bytes);
  };
  // ScreenViewer has no clipboard integration. Consume these messages without
  // decoding extended-clipboard zlib, whose inner length is server-controlled.
  rfb._handleServerCutText = () => {
    if (failed) return false;
    const socket = rfb._sock;
    if (socket.rQwait("clipboard header", 7, 1)) return false;
    socket.rQskipBytes(3);
    const length = Math.abs(socket.rQshift32() | 0);
    if (length > 1024 * 1024) return reject("Screen clipboard exceeds the preview limit");
    if (socket.rQwait("clipboard content", length, 8)) return false;
    socket.rQskipBytes(length);
    return true;
  };
}
