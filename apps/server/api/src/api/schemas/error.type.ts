import { BackendErrorCodes } from "@internal/backend-errors";
import { t } from "elysia";

// Don't use t.Enum. You won't get proper typescript types in
// the client generation or Swagger UI.
export const BackendErrorCodeSchema = t.String({
  enum: Object.values(BackendErrorCodes),
  title: "Backend error code",
  description: "Machine-readable error code. Branch on this rather than on the message.",
});

/**
 * The body returned by the global `errorHandler` for any failed request.
 *
 * Outside production the handler returns `ApiError.toJSON()`, which adds `stack`
 * and `causedBy`; in production it returns `ApiError.toJSONSafe()`. The schema is
 * therefore declared with `additionalProperties: true` and only pins the fields
 * that are present in both shapes.
 */
export const ApiErrorResponseSchema = t.Object(
  {
    errId: t.String({
      description: "Unique ID for this specific error occurrence. Include it in bug reports.",
    }),
    code: BackendErrorCodeSchema,
    message: t.String({
      description: "Human-readable error message",
    }),
    statusCode: t.Number({
      description: "HTTP status code associated with the error code",
    }),
    reqId: t.Optional(
      t.String({
        description: "ID of the request that produced the error, when request-scoped logging is active",
      }),
    ),
    metadata: t.Optional(
      t.Record(t.String(), t.Any(), {
        description: "Client-safe metadata attached to the error via `metadataSafe`",
      }),
    ),
  },
  {
    additionalProperties: true,
    description: "Standard API error response",
  },
);

export type ApiErrorResponse = typeof ApiErrorResponseSchema.static;
