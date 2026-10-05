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

/** Response body cap relayed back over the session (the rest_response frame must fit the session cap with headroom). */
const MAX_RESPONSE_BODY_BYTES = 200_000;
/** A self-fetch that dawdles past this is answered 504; a wedged route must not hold the callback slot forever. */
const CALLBACK_TIMEOUT_MS = 25_000;

export async function executeCallbackAsPane(
  session: SshRuntimeSession,
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
    let text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BODY_BYTES) {
      text = `${text.slice(0, MAX_RESPONSE_BODY_BYTES)}\n{"subshell_truncated": true}`;
    }
    return { status: response.status, body: text };
  } catch (err) {
    // warn, not debug: a silent 504 would make a refused callback indistinguishable
    // from an unreachable plane, and the refusal distinction is the point of §5.
    logger.withError(err).warn(`ssh-runtime self-fetch failed for ${method} ${path}`);
    return { status: 504, body: JSON.stringify({ error: "callback execution timed out or failed" }) };
  } finally {
    clearTimeout(timer);
  }
}
