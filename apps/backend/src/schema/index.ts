import { Elysia } from "elysia";
import { ApiErrorResponseSchema } from "@/schema/error.type.js";

/**
 * Registers the shared response models under stable names so routes can
 * reference them from `response` schemas (e.g. `response: { 400: "ApiErrorResponse" }`)
 * without importing the TypeBox object into every file.
 */
export const apiModels = new Elysia({ name: "api-models" })
  .model({
    ApiErrorResponse: ApiErrorResponseSchema,
  })
  .as("global");
