/**
 * Thin REST client used by `mote mcp` to reach the mote backend over
 * `Authorization: Bearer <session token>`. Deliberately tiny: it knows only
 * how to send authenticated JSON and surface HTTP failures as {@link ApiError}
 * (the tool layer turns those into agent-facing guidance).
 */

/** Thrown for any non-2xx response; carries the status for error mapping. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Pulls the human-readable message out of a failed response body. The backend
 * answers every failure with the structured `ApiErrorResponse` JSON
 * (`{errId, code, message, statusCode}`); anything that is not that shape
 * (legacy text, a proxy error page) is passed through verbatim.
 */
function extractErrorMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return (parsed as { message: string }).message;
    }
  } catch {
    // Not JSON — plain text, used as-is.
  }
  return raw;
}

/** Where to reach the backend and with what credential. */
export interface MoteApiConfig {
  baseUrl: string;
  apiKey: string;
}

export class MoteApi {
  constructor(private readonly config: MoteApiConfig) {}

  /** Issues one request and returns the parsed JSON body (or throws ApiError). */
  async req<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number>; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.apiKey}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await fetch(url, { method: init.method ?? "GET", headers, body, signal: init.signal });
    if (!res.ok) {
      // Parse the FULL body before truncating: structured error bodies can
      // exceed 300 chars (validation payloads), and slicing first would tear
      // the JSON and surface a blob where a clean `message` exists.
      const raw = await res.text().catch(() => "");
      const message = extractErrorMessage(raw) || res.statusText;
      throw new ApiError(res.status, message.slice(0, 300));
    }
    // 204 / empty bodies resolve to undefined rather than a JSON parse error.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
