/**
 * Reading the client half of the `/ws` wire (spec 2026-09-21 Wave B).
 *
 * The plugin's `message` hook hands frames here before they reach the shared
 * client-frame dispatch. Elysia JSON-parses `{`-leading text frames already,
 * so strings and parsed objects pass through untouched: that path is
 * byte-identical to before the negotiation existed, including where the
 * "dropped unrecognized frame" warning fires. Only a BINARY frame is new: it
 * is CBOR, decoded here, and a frame that does not decode becomes null, which
 * the dispatcher drops the same way it drops anything unrecognized.
 *
 * Tolerance is deliberate (spec decision): in CBOR mode a client that slips a
 * TEXT frame still gets served, because Elysia's parsed object flows through
 * this function unchanged.
 */

import { decodeFrame } from "@internal/subshell-protocol/wire";

/**
 * Decodes one incoming WebSocket frame in either wire mode.
 * @param message - The raw frame as Elysia delivered it: a JSON string, an
 *   already-parsed object, CBOR bytes (`Uint8Array`), or raw binary
 * @returns The decoded frame, the input unchanged when nothing needed
 *   decoding, or null when CBOR bytes failed to decode
 */
export function decodeIncoming(message: unknown): unknown {
  if (message instanceof ArrayBuffer) {
    try {
      return decodeFrame(new Uint8Array(message));
    } catch {
      return null;
    }
  }
  if (message instanceof Uint8Array) {
    try {
      return decodeFrame(message);
    } catch {
      return null;
    }
  }
  return message;
}
