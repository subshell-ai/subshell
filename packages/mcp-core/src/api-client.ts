/**
 * Thin REST client used by `subshell mcp` to reach the subshell backend over
 * `Authorization: Bearer <subshell token>`. Deliberately tiny: it knows only
 * how to send authenticated JSON and surface HTTP failures as {@link ApiError}
 * (the tool layer turns those into agent-facing guidance).
 */

/** Thrown for any non-2xx response; carries the status for error mapping. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The backend's machine-readable code from the structured body
     * (`ApiErrorResponse.code`). It is the stable half of the contract; the
     * message is prose. Status-carried throw classes get their own names
     * genericized by the server's error handler (a 409 carrier answers
     * `EXISTS_ERROR`, not its private code), so the tool layer maps only the
     * codes the server rides by name and treats everything else by status.
     */
    readonly code?: string,
    /**
     * The structured body's client-safe metadata (`ApiErrorResponse.metadata`,
     * set server-side via `metadataSafe`), carried through verbatim so any
     * refusal that names itself in metadata (e.g. `metadata.sshCode` on the
     * SSH-runtime surface) stays inspectable at the tool layer.
     */
    readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Pulls the message AND the machine code out of a failed response body. The
 * backend answers every failure with the structured `ApiErrorResponse` JSON
 * (`{errId, code, message, statusCode}`); anything that is not that shape
 * (legacy text, a proxy error page) is passed through verbatim with no code.
 */
function extractErrorBody(raw: string): { message: string; code?: string; metadata?: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const body = parsed as { message?: unknown; code?: unknown; metadata?: unknown };
      return {
        message: typeof body.message === "string" ? body.message : raw,
        ...(typeof body.code === "string" ? { code: body.code } : {}),
        ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? { metadata: body.metadata as Record<string, unknown> }
          : {}),
      };
    }
  } catch {
    // Not JSON: plain text, used as-is.
  }
  return { message: raw };
}

/** Where to reach the backend and with what credential. */
export interface SubshellApiConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * The runtime pane's callback door (design 2026-10-05 §5, task 25): a unix
   * socket path. Set for panes an SSH runtime session launched, and when set
   * EVERY request connects there (`fetch`'s `unix` transport - Bun's absolute
   * socket path; the URL's host is never resolved, so the sentinel base URL
   * in a pane env stays the dead-by-DNS guard it is). The plane authenticates
   * each request as this pane by the door it arrives on, so `apiKey` is unused
   * in this mode - the runtime contract is that no bearer material crosses
   * the wire.
   */
  callbackSock?: string | null;
}

export class SubshellApi {
  constructor(private readonly config: SubshellApiConfig) {}

  /** Issues one request and returns the parsed JSON body (or throws ApiError). */
  async req<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number>; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
    // In door mode there is no key to send; an `Authorization` header naming
    // an empty bearer would be a misleading artifact, and the callback
    // executor's own auth (the plane's minted token) is the real one.
    const headers: Record<string, string> =
      this.config.callbackSock != null ? {} : { authorization: `Bearer ${this.config.apiKey}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const fetchInit: RequestInit & { unix?: string } = {
      method: init.method ?? "GET",
      headers,
      body,
      signal: init.signal,
    };
    // The door branch: Bun resolves the socket path and NEVER touches the URL
    // host, so the sentinel base URL stays what it is - a dead-by-DNS guard
    // for any code path that bypasses this one. The `unix` field rides in the
    // init object so a test seam sees the transport decision, not just the
    // composed URL.
    if (this.config.callbackSock != null) fetchInit.unix = this.config.callbackSock;
    const res = await fetch(url, fetchInit);
    if (!res.ok) {
      // Parse the FULL body before truncating: structured error bodies can
      // exceed 300 chars (validation payloads), and slicing first would tear
      // the JSON and surface a blob where a clean `message` exists.
      const raw = await res.text().catch(() => "");
      const { message, code, metadata } = extractErrorBody(raw);
      throw new ApiError(res.status, (message || res.statusText).slice(0, 300), code, metadata);
    }
    // 204 / empty bodies resolve to undefined rather than a JSON parse error.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
