import { ApiError, BackendErrorCodes, createApiError, getErrorStatusCode } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { IS_PROD } from "@/constants.js";
import { getLogger } from "@/utils/logger.js";

/**
 * Serializes an ApiError for the wire. Outside production the full error is
 * returned (including `stack` and `causedBy`); in production only the
 * client-safe fields are.
 */
function serialize(error: ApiError) {
  return IS_PROD ? error.toJSONSafe() : error.toJSON();
}

/**
 * Reverse-maps an HTTP status to the `BackendErrorCodes` entry whose definition
 * carries that status (401→INVALID_CREDENTIALS, 403→ACCESS_DENIED,
 * 404→NOT_FOUND_ERROR, 409→EXISTS_ERROR, 400→BAD_REQUEST). Anything else falls
 * back by class: 4xx→BAD_REQUEST, 5xx→INTERNAL_SERVER_ERROR.
 *
 * INPUT_VALIDATION_ERROR is deliberately skipped even though its status is 400:
 * a bare status carrier says nothing about *why* the request failed, and
 * BAD_REQUEST is the honest generic. The lookup order pins 400→BAD_REQUEST.
 */
function codeForStatus(status: number): BackendErrorCodes {
  const preferred = [
    BackendErrorCodes.BAD_REQUEST,
    BackendErrorCodes.INVALID_CREDENTIALS,
    BackendErrorCodes.ACCESS_DENIED,
    BackendErrorCodes.NOT_FOUND_ERROR,
    BackendErrorCodes.EXISTS_ERROR,
  ];
  for (const code of preferred) {
    if (getErrorStatusCode(code) === status) return code;
  }
  return status >= 500 ? BackendErrorCodes.INTERNAL_SERVER_ERROR : BackendErrorCodes.BAD_REQUEST;
}

/**
 * Global error handler.
 *
 * This is the safety net for failures that are **thrown**: unexpected errors,
 * `ApiError`s raised by `throwApiError`, subshell's `status`-carrying error classes
 * (`HttpError`, `UnauthorizedError`, `ForbiddenError`, per-route `*Error`s), and
 * Elysia's own schema validation. A route's expected failures are returned with
 * `status()` + `apiErrorBody()` and do not pass through here — see
 * `src/lib/api-error.ts`.
 *
 * Either way the response body is identical, and is described by
 * `ApiErrorResponseSchema` in `src/schema/error.type.ts`. **Every status code is
 * preserved unchanged** — with one deliberate exception: Elysia's native 422
 * validation failure becomes 400 `INPUT_VALIDATION_ERROR`, matching the shared
 * contract.
 *
 * ## Why this does not use `.error()`
 *
 * Elysia's documented pattern for custom errors is to register the class with
 * `.error({ API_ERROR: ApiError })` and switch on the narrowed `code` in `onError`.
 * That does not work for `ApiError`, because Elysia derives `code` from the thrown
 * error's own `code` property when it has one — and `ApiError.code` is already a
 * `BackendErrorCodes` value that we deliberately expose on the wire. Registering
 * the class yields `code === "NOT_FOUND_ERROR"`, never `"API_ERROR"`, so the switch
 * silently falls through to the 500 branch.
 *
 * An `instanceof` check is therefore the correct discriminator here. Keep it first:
 * it must run before any check against `code`.
 *
 * @see https://elysiajs.com/patterns/error-handling.html
 */
export const errorHandlerPlugin = new Elysia({ name: "error-handler" })
  .onError(({ code, error, set }) => {
    const log = getLogger();

    // An ApiError raised by throwApiError(). Expected failures are returned via
    // status() + apiErrorBody() and never reach this handler, so what arrives here
    // is an unexpected failure. Must be checked before `code`, see the note above.
    if (error instanceof ApiError) {
      if (!error.doNotLog) {
        // `child()` first — `withContext` mutates the logger it is called on, and
        // this id must not leak onto unrelated lines afterwards.
        log
          .child()
          .withContext({ errId: error.errId })
          .errorOnly(error, {
            logLevel: error.logLevel as any,
          });
      }

      // isInternalError hides the real cause from the client but keeps it in the
      // log, reusing the same errId so the two can be correlated.
      if (error.isInternalError) {
        const wrapped = createApiError({
          code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
          causedBy: error,
          ...(error.validationError ? { validationError: error.validationError } : {}),
        });

        wrapped.errId = error.errId;
        set.status = wrapped.statusCode;

        return serialize(wrapped);
      }

      set.status = error.statusCode;

      return serialize(error);
    }

    // Elysia's own schema validation failure, rewritten into the standard error
    // body so a client only ever parses one shape. This turns Elysia's native 422
    // into a 400 INPUT_VALIDATION_ERROR — the one intentional status change.
    if (code === "VALIDATION") {
      const validationError = createApiError({
        code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
        validationError: {
          // Elysia does not expose a type for the validation payload on the
          // error it throws; `all` is the array of individual field failures.
          validation: (error as any)?.all ?? [],
          // Elysia's ValidationError says which part failed (`body`, `query`,
          // `params`, …); "body" is the fallback for hand-rolled validation throws.
          validationContext: (error as any)?.type ?? "body",
          message: error.message ?? "Validation error",
        },
        causedBy: error,
      });

      set.status = validationError.statusCode;

      return serialize(validationError);
    }

    // subshell's `status`-carriers: `HttpError`, `UnauthorizedError`, `ForbiddenError`
    // (auth-guard) and the per-route classes (`FilesError`, …) carry only a
    // numeric `.status` — plus sometimes a private `.code` that is NOT part of the
    // wire contract and must not leak. Duck-typed instead of imported so this
    // plugin stays free of auth-guard/route dependencies (no cycles).
    // Checked after VALIDATION: Elysia's own ValidationError also carries a
    // status (422) and deserves the richer branch above.
    const carriedStatus = (error as { status?: unknown } | null | undefined)?.status;
    if (typeof carriedStatus === "number" && carriedStatus >= 400 && carriedStatus <= 599) {
      const carried = createApiError({
        code: codeForStatus(carriedStatus),
        message: error instanceof Error ? error.message : "Request failed",
        doNotLog: carriedStatus < 500,
      });

      // Keep the carried status on the body, not just the code's default: a
      // 418 carrier stays 418 even though its code maps to BAD_REQUEST's 400.
      carried.statusCode = carriedStatus;

      if (!carried.doNotLog) {
        log
          .child()
          .withContext({ errId: carried.errId })
          .errorOnly(carried, { logLevel: carried.logLevel as any });
      }

      set.status = carriedStatus;

      return serialize(carried);
    }

    // Anything with no status at all — a plain `new Error("…")` from a service,
    // a TypeError, whatever. Never show its message to the client.
    const internalError = createApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "An internal server error occurred.",
      causedBy: error,
    });

    log
      .child()
      .withContext({ errId: internalError.errId })
      .errorOnly(error as Error);

    set.status = internalError.statusCode;

    return serialize(internalError);
  })
  .as("global");
