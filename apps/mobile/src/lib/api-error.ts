/**
 * The backend's structured error contract, mirrored for the native client.
 *
 * Every non-2xx from mote carries `ApiErrorResponseSchema`
 * (`apps/backend/src/schema/error.type.ts`):
 * `{ errId, code, message, statusCode, reqId?, metadata? }`. The web app has the
 * same helpers in `apps/frontend/src/lib/api.ts`; they live in two apps rather
 * than one package because there is no shared client package yet — if a third
 * consumer appears, promote this module instead of pasting it again.
 */

/** A failed request that keeps the HTTP status as a number for branching. */
export class ApiError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** Machine-readable `BackendErrorCodes` value (e.g. "NOT_FOUND_ERROR"). */
  readonly code?: string;
  /** Server-side id of this occurrence — the thing to quote when reporting a bug. */
  readonly errId?: string;

  /**
   * @param status - HTTP status of the failed response
   * @param body - Display text (the structured body's `message` when present)
   * @param meta - Structured fields lifted out of the error body
   */
  constructor(status: number, body: string, meta: { code?: string; errId?: string } = {}) {
    super(`API ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
    this.status = status;
    this.code = meta.code;
    this.errId = meta.errId;
  }
}

/**
 * Splits a failed response body into display text plus structured fields.
 * Anything that is not the contract shape — a proxy error page, an HTML 502,
 * an older plain-text body — falls back to the raw text so the
 * `API <status>: <detail>` copy keeps one form.
 * @param raw - The response body text
 * @returns The message plus `code`/`errId` when the body carried them
 */
export function parseErrorBody(raw: string): { message: string; code?: string; errId?: string } {
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
    // Not JSON — a legacy or foreign body, used verbatim.
  }
  return { message: raw };
}

/**
 * Display text for a caught failure, with a caller-supplied fallback.
 * @param err - The value from a `catch` block
 * @param fallback - Text to show when `err` carries no message
 * @returns The message or the fallback
 */
export function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * True when a failed call means the target is already where the call was trying
 * to get it — 404 (deleted elsewhere while this screen held a stale id) or
 * 410 Gone. Converging on "gone" is the normal outcome rather than an error
 * worth showing; a restart no longer invalidates ids (it revives the row).
 * @param err - The error caught from a request
 * @returns Whether the resource should be treated as already gone
 */
export function isAlreadyGone(err: unknown): boolean {
  if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return true;
  return err instanceof Error && /^API 404:/.test(err.message);
}
