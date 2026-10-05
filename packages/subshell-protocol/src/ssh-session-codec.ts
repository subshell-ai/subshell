/**
 * The SSH-session transport codec: 4-byte big-endian length prefix + one JSON
 * frame (design 2026-10-05 §2: "the SSH child's stdin/stdout, 4-byte
 * big-endian length prefix + one JSON frame").
 *
 * This is the codec for the RUNTIME link that rides the SSH child's stdio -
 * NOT the node-link websocket, which frames its own messages through Bun. The
 * three consumers share one file so the two ends cannot drift: the runtime
 * (stdout is protocol-only), the plane's session reader (child stdout bytes
 * arrive in arbitrary chunks re-sealed through `session_frame` events, so the
 * decoder MUST buffer across pushes and MUST reassemble frames split by a
 * chunk boundary), and unit tests.
 *
 * Fail-closed is the whole posture: an oversized declared length, a frame
 * that does not parse, or a leading byte run that cannot begin a frame
 * (login banner text, a PTY echo) permanently breaks the decoder - never a
 * skip, never a resync. A broken decoder is what makes the design's "login
 * banners and malformed leading bytes fail the open" true; there is no code
 * path that looks for the next plausible JSON start.
 *
 * Imports no `node:` builtin (TextEncoder/TextDecoder are web globals
 * present in Bun, Node and Hermes); this module is in the Metro-safe barrel.
 */

/**
 * Largest single frame on the runtime link (`MAX_SESSION_FRAME_BYTES` in the
 * design freeze). 256 KiB base64s to about 350 KiB, which the broker then
 * seals under the node link's own {@link NODE_MAX_FRAME_BYTES} cap - the
 * smaller number is the runtime's because a runtime frame must fit inside a
 * session_frame event with headroom.
 */
export const SSH_SESSION_FRAME_MAX_BYTES = 262_144;

/** Length-prefix width both ends agree on. */
const LENGTH_PREFIX_BYTES = 4;

/** A decoder's terminal verdict once it stops accepting bytes; the reason rides into the close and the log. */
export type SshSessionCodecFailure = "oversize" | "malformed-json" | "not-json-object";

/**
 * Encode one frame: the JSON bytes with their length as a 4-byte big-endian
 * prefix. Throws on a frame whose JSON exceeds {@link
 * SSH_SESSION_FRAME_MAX_BYTES} - the sender refusing is the codec's half of
 * the bounded-frame promise; a sender that cannot build a frame must decide
 * its own remedy (chunk, or fail the call), never emit a lying prefix.
 *
 * @param frame - any JSON-serializable value (the session's frame types)
 * @returns the exact bytes to write to the stream
 */
export function encodeSshSessionFrame(frame: unknown): Uint8Array {
  const json = JSON.stringify(frame);
  const body = new TextEncoder().encode(json);
  if (body.byteLength > SSH_SESSION_FRAME_MAX_BYTES) {
    throw new Error(`session frame exceeds ${SSH_SESSION_FRAME_MAX_BYTES} bytes`);
  }
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength, false);
  out.set(body, LENGTH_PREFIX_BYTES);
  return out;
}

/**
 * Streaming decoder for the length-prefixed frame grammar.
 *
 * `push` accepts arbitrarily split bytes (an SSH child's stdout arrives in
 * whatever pieces the transport chose) and returns the frames that COMPLETED
 * during that push, in order. Once {@link failed} is set the decoder is
 * terminal: every further push returns nothing (fail-closed - a stream that
 * produced garbage once is not re-joined at the next plausible boundary).
 */
export class SshSessionFrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  #failure: SshSessionCodecFailure | null = null;

  /** The terminal failure, or null while the decoder still accepts bytes. */
  get failed(): SshSessionCodecFailure | null {
    return this.#failure;
  }

  /**
   * Feed bytes; get back the JSON values of every frame completed by them.
   * A declared length above {@link SSH_SESSION_FRAME_MAX_BYTES} fails the
   * whole stream (`oversize`) the moment the four prefix bytes are seen,
   * before any body byte is demanded - a lying prefix must not be able to
   * make the reader buffer unboundedly.
   *
   * @param chunk - the next bytes of the stream (any size, may split frames)
   * @returns the parsed frames in stream order; empty when nothing completed
   */
  push(chunk: Uint8Array): unknown[] {
    const frames: unknown[] = [];
    if (this.#failure !== null || chunk.byteLength === 0) return frames;
    this.#buffer = concat(this.#buffer, chunk);
    for (;;) {
      if (this.#buffer.byteLength < LENGTH_PREFIX_BYTES) return frames;
      const declared = new DataView(this.#buffer.buffer as ArrayBuffer, this.#buffer.byteOffset).getUint32(0, false);
      if (declared > SSH_SESSION_FRAME_MAX_BYTES) {
        this.#fail("oversize");
        return frames;
      }
      const total = LENGTH_PREFIX_BYTES + declared;
      if (this.#buffer.byteLength < total) return frames; // wait for the rest of the body
      const body = this.#buffer.subarray(LENGTH_PREFIX_BYTES, total);
      this.#buffer = this.#buffer.slice(total);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        this.#fail("malformed-json");
        return frames;
      }
      // The session grammar only ever carries objects; a bare string or
      // array frame is the same class of stream corruption as bad JSON.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.#fail("not-json-object");
        return frames;
      }
      frames.push(parsed);
    }
  }

  #fail(reason: SshSessionCodecFailure): void {
    this.#failure = reason;
    this.#buffer = new Uint8Array(0);
  }
}

/** Copy-free-enough concat for the sizes here (a frame is <= 256 KiB and pushes are chunk-sized). */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
