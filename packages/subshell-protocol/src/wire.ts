/**
 * The `/ws` frame encoder: one module both wire modes flow through.
 *
 * `/ws` speaks JSON by default and CBOR binary when the attach URL negotiates
 * it (`&enc=cbor`, spec 2026-09-21 Wave B). This module is the ONLY place that
 * imports `cbor2`, for two reasons:
 *
 * - **The subpath export, not the barrel.** `apps/client/mobile` imports the
 *   package barrel through Metro, which cannot resolve every module shape the
 *   barrel's other subpaths already avoid (see the `release-artifacts` note in
 *   `src/index.ts`). CBOR is a server-and-browser-SPA concern for now; mobile
 *   adoption is its own follow-up, so the wrapper stays out of the barrel.
 * - **No call site imports `cbor2` directly.** One wrapper is where an encode
 *   option (a determinism policy, a size guard) would land once.
 *
 * The decoder accepts BOTH modes: a string is JSON (so one decoder serves a
 * client that slipped a text frame, and an un-negotiated socket's traffic),
 * bytes are CBOR. Malformed input throws; the receivers own the catch.
 */

import { decode as cborDecode, encode as cborEncode } from "cbor2";

/** Which encoding a socket speaks. Absent/anything unrecognized means JSON. */
export type WireMode = "json" | "cbor";

/** The attach-URL query parameter that negotiates the encoding. */
export const WIRE_MODE_PARAM = "enc";

/** The only value of {@link WIRE_MODE_PARAM} that switches the wire to CBOR. */
export const CBOR_VALUE = "cbor";

/**
 * Reads a wire mode off its URL spelling. Only the exact value `"cbor"`
 * negotiates; anything else (absent, empty, a typo) is today's JSON, which is
 * what keeps an older or hand-built client byte-identical.
 * @param raw - The parameter value, or null/undefined when absent
 * @returns The negotiated mode, JSON unless the client asked for CBOR
 */
export function parseWireMode(raw: string | null | undefined): WireMode {
  return raw === CBOR_VALUE ? "cbor" : "json";
}

/**
 * Encodes one frame for the wire.
 * @param frame - The frame object (server or client shape)
 * @returns The CBOR bytes to send as one binary WebSocket frame. The
 *   `ArrayBuffer` spelling matters for the DOM's `WebSocket.send`, which
 *   refuses a `Uint8Array` backed by a SharedArrayBuffer: cbor2 always
 *   allocates its own buffer, so the narrowing is a statement of fact about
 *   what the encoder produces, not a suppression of a real case.
 */
export function encodeFrame(frame: unknown): Uint8Array<ArrayBuffer> {
  return cborEncode(frame) as Uint8Array<ArrayBuffer>;
}

/**
 * Decodes one received frame, in either wire mode.
 * @param data - CBOR bytes, or a JSON string (a text frame)
 * @returns The decoded frame object
 */
export function decodeFrame(data: Uint8Array | string): unknown {
  if (typeof data === "string") return JSON.parse(data);
  return cborDecode(data);
}
