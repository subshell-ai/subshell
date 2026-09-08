import { type ApiErrorShort, createApiError } from "@internal/backend-errors";
import { IS_PROD } from "@/constants.js";
import type { ApiErrorResponse } from "@/schema/error.type.js";
import { getLogger } from "@/utils/logger.js";

/**
 * Builds the standard API error body for a `status()` return.
 *
 * Elysia recommends returning `status(...)` rather than throwing, because only a
 * returned value is checked against the route's `response` schema and narrowed by
 * status for Eden Treaty clients. A returned status does **not** pass through
 * `onError`, so this helper takes over the two jobs the global handler would
 * otherwise do: logging the failure with its `errId`, and picking the
 * production-safe serialization.
 *
 * @example
 * if (!user) {
 *   return status(404, apiErrorBody({
 *     code: BackendErrorCodes.NOT_FOUND_ERROR,
 *     message: "No user exists with that ID",
 *     metadataSafe: { userId },
 *   }));
 * }
 *
 * @param params - Same options as `createApiError`. `logLevel` defaults to
 *   `"debug"` rather than `"error"`: an expected 4xx that a route deliberately
 *   returns is not a server fault and should not fill the error log.
 * @returns The response body, matching `ApiErrorResponseSchema`.
 *
 * @see https://elysiajs.com/essential/handler.html
 */
export function apiErrorBody({ logLevel = "debug", ...params }: ApiErrorShort): ApiErrorResponse {
  const error = createApiError({ ...params, logLevel });

  if (!error.doNotLog) {
    getLogger()
      // `child()` first: `withContext` mutates the instance it is called on, so
      // setting errId on the shared logger would leave it attached to every later
      // line, including successful requests and the shutdown message.
      .child()
      .withContext({ errId: error.errId })
      // ApiError types logLevel as a string union; LogLayer wants its own LogLevel
      // enum. The values line up, but the nominal types do not.
      .errorOnly(error, { logLevel: error.logLevel as any });
  }

  return (IS_PROD ? error.toJSONSafe() : error.toJSON()) as ApiErrorResponse;
}
