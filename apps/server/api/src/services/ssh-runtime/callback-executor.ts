import { SSH_SESSION_FRAME_MAX_BYTES } from "@internal/subshell-protocol";
import { SERVER_PORT } from "@/constants.js";
import { logger } from "@/utils/logger.js";
import type { SshRuntimeSession } from "./session.js";

/**
 * Execute one allowlisted callback as the pane's own token (design 2026-10-05
 * §5): the same HTTP the pane itself would send, pointed at this instance,
 * authenticated with the token the plane minted at launch and never
 * transmitted to the destination.
 *
 * Loopback self-fetch over `127.0.0.1:SERVER_PORT` rather than an in-process
 * handler call is the decision, and it is load-bearing: the request then
 * passes the REAL guard chain (`authGuard`, the per-subshell boost-and-
 * grants switch-off keyed to the pane's own key) instead of a copy of it,
 * which is exactly the promise §5 makes - "the plane executes the path AS
 * the pane's own subshell token". `127.0.0.1` is hardcoded rather than read
 * off `APP_BASE_URL` because the destination's view of where the plane lives
 * must stay irrelevant (a hostname that resolves elsewhere would silently
 * turn the callback into an outbound hop), and the port is the one this
 * process binds.
 */

/**
 * A self-fetch that dawdles past this is answered 504; a wedged route must not
 * hold the callback slot forever.
 */
const CALLBACK_TIMEOUT_MS = 25_000;

/** A prefix-cut UTF-8 buffer to a codepoint boundary (drop trailing continuation bytes). */
function utf8Prefix(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.byteLength);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/** The honest wrap: parseable JSON saying the body was cut, with the kept prefix inside. */
function wrapTruncated(prefix: string): string {
  return JSON.stringify({ subshell_truncated: true, body: prefix });
}

/**
 * Encoded size of the rest_response frame the answer WOULD produce: measured
 * with the ACTUAL `reqId` (the id of the request being answered), not a
 * stand-in. That is what makes the fit guarantee true rather than claimed:
 * the id is bounded by the inbound frame grammar (`SSH_REQ_ID_MAX_CHARS`,
 * printable), the status and keys are fixed-shape, and the composition
 * mirrors the codec's exactly (4-byte prefix + the JSON bytes), so the frame
 * `session.ts` encodes with this same id cannot exceed the cap. It is not
 * measured THROUGH `encodeSshSessionFrame` itself: the binary search measures
 * CANDIDATES over the cap, and the encoder THROWS past it - a throwing probe
 * would have made the search throw exactly the failure this prevents.
 */
function responseFrameBytes(reqId: string, status: number, body: string): number {
  const json = JSON.stringify({ type: "rest_response", reqId, status, body });
  return 4 + Buffer.byteLength(json);
}

/**
 * Cap a response body for the session frame (the review's M2, refined by the
 * review's I-A): the old code sliced UTF-16 characters against a byte budget
 * and appended a marker line, which (a) could encode past the 256 KiB frame
 * cap (multibyte text costs more bytes than chars), (b) made the JSON
 * unparsable (a sentence glued after a complete document), and (c) let the
 * encode throw inside the settle - answering a false 502 for a call that
 * succeeded. The I-A finding added the third measurement axis: an unbounded
 * reqId defeats even a byte-exact body cut, so the id is now grammar-bounded
 * inbound AND the ACTUAL id is used in the measurement here (no padded
 * stand-in: a padded id that under-counts the real one's JSON escapes leaves
 * the same overshoot, just smaller).
 *
 * Now: a body whose frame already fits passes through untouched; an oversize
 * body is cut on a UTF-8 BYTE boundary and wrapped in `{"subshell_truncated":
 * true, "body": ...}` - valid JSON by construction, at most the frame cap
 * after encoding INCLUDING the wrapper and the envelope as THIS reqId makes
 * it (binary search over prefix lengths against the real composition).
 *
 * @internal exported for the boundary tests; production calls go through
 *           {@link executeCallbackAsPane}.
 */
export function fitCallbackBody(reqId: string, status: number, text: string): string {
  if (responseFrameBytes(reqId, status, text) <= SSH_SESSION_FRAME_MAX_BYTES) return text;
  const buf = Buffer.from(text, "utf8");
  // Invariant: `lo` fits (the empty wrap always does - it is a few dozen
  // bytes against a 256 KiB cap), `hi` is the largest prefix that might.
  let lo = 0;
  let hi = buf.byteLength;
  let best = wrapTruncated("");
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = wrapTruncated(utf8Prefix(buf, mid));
    if (responseFrameBytes(reqId, status, candidate) <= SSH_SESSION_FRAME_MAX_BYTES) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Execute one allowlisted callback as the pane's own token and hand back the
 * answer READY for the frame: the body is capped against the frame that
 * carries THIS `reqId` (the id arrives grammar-bounded; the fit measurement
 * uses it verbatim), so the answer the session encodes cannot exceed the cap.
 */
export async function executeCallbackAsPane(
  session: SshRuntimeSession,
  reqId: string,
  paneId: string,
  method: string,
  path: string,
  body: string | undefined,
): Promise<{ status: number; body: string }> {
  const token = session.paneToken(paneId);
  if (token === undefined) {
    // The allowlist matched but the token is gone (the pane was unregistered
    // mid-flight). Refuse rather than find a second identity: this door only
    // ever opens as the pane.
    return { status: 401, body: JSON.stringify({ error: "pane token no longer issued" }) };
  }
  const url = new URL(path, `http://127.0.0.1:${SERVER_PORT}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && body !== "" ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined && body !== "" ? { body } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, body: fitCallbackBody(reqId, response.status, text) };
  } catch (err) {
    // warn, not debug: a silent 504 would make a refused callback indistinguishable
    // from an unreachable plane, and the refusal distinction is the point of §5.
    logger.withError(err).warn(`ssh-runtime self-fetch failed for ${method} ${path}`);
    return { status: 504, body: JSON.stringify({ error: "callback execution timed out or failed" }) };
  } finally {
    clearTimeout(timer);
  }
}
