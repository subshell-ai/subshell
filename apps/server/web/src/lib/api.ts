/**
 * Typed API client (Eden Treaty from the backend's OpenAPI) + plain fetch
 * helpers. Requests are same-origin with cookie credentials so the
 * better-auth session cookie is sent automatically.
 */

/**
 * An apiFetch failure with the HTTP status kept as a number — callers that
 * branch on the code (403 → "admin only") read `status` instead of parsing the
 * message. The message format matches the historical text.
 */
export class ApiError extends Error {
  readonly status: number;
  /**
   * Machine-readable code from the backend's structured error body
   * (e.g. "NOT_FOUND_ERROR"); undefined for legacy plain-text failures.
   */
  readonly code?: string;
  /**
   * Server-side id of this error occurrence from the structured body — the
   * thing to quote when reporting a bug; undefined for legacy text failures.
   */
  readonly errId?: string;
  constructor(status: number, body: string, meta: { code?: string; errId?: string } = {}) {
    super(`API ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
    this.status = status;
    this.code = meta.code;
    this.errId = meta.errId;
  }
}

/**
 * The request never got an HTTP answer — DNS failure, refused connection,
 * dropped socket: the server (or its proxy) is DOWN. `ApiError` means the
 * opposite (something answered with a status). The retry policy and the
 * offline banner both key off this one distinction.
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? `Server unreachable: ${cause.message}` : "Server unreachable", { cause });
    this.name = "NetworkError";
  }
}

/** True when a caught failure means "no HTTP answer" (see {@link NetworkError}). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof NetworkError;
}

/**
 * A deliberately aborted request (AbortController), NOT a failure. It looks
 * like a fetch rejection, so `apiFetch` must NOT launder it into a
 * {@link NetworkError} — callers that cancel superseded requests (the debounced
 * workspace-layout save) branch on this to stay quiet.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Splits a failed response body into the display message and the structured
 * fields. Every backend failure now carries `{errId, code, message, statusCode}`;
 * anything that is not that shape (a proxy error page, an older body) falls
 * back to the raw text so the `API <status>: <detail>` copy never changes form.
 */
function parseErrorBody(raw: string): { message: string; code?: string; errId?: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const { message, code, errId } = parsed as { message?: unknown; code?: unknown; errId?: unknown };
      return {
        message: typeof message === "string" ? message : raw,
        code: typeof code === "string" ? code : undefined,
        errId: typeof errId === "string" ? errId : undefined,
      };
    }
  } catch {
    // Not JSON — a legacy or foreign plain-text body; used verbatim.
  }
  return { message: raw };
}

/** Fetch helper that includes the session cookie (same-origin by default). */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new NetworkError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const { message, code, errId } = parseErrorBody(body);
    throw new ApiError(res.status, message, { code, errId });
  }
  return (await res.json()) as T;
}

/** POST JSON helper. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Display text for a caught failure: the message when there is one (an
 * `ApiError` included — its message is already `API <status>: <detail>`),
 * the caller's fallback for anything else. The single spelling of the
 * `err instanceof Error ? err.message : "…"` idiom every catch used to
 * re-type.
 * @param err - The value from a `catch` block
 * @param fallback - Text to show when `err` carries no message
 * @returns The message or the fallback
 */
export function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * True when a failed call means the target is already in the state the call
 * was trying to reach — a 404 (deleted elsewhere, or by an earlier click that
 * finished server-side but not in the UI) or a 410 Gone. Converging on that
 * state is correct for deletes whose id comes from the app's own render
 * state, never from user input; a genuine failure (5xx, network) still
 * surfaces.
 *
 * Checks `ApiError.status` rather than regex-parsing the message, keeping the
 * old `^API 404:` message test as a fallback for hand-thrown errors — so
 * every input the message-based version accepted still converges.
 * @param err - The error caught from an `apiFetch` call
 * @returns Whether the resource is already gone
 */
export function isAlreadyGone(err: unknown): boolean {
  if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return true;
  return err instanceof Error && /^API 404:/.test(err.message);
}
