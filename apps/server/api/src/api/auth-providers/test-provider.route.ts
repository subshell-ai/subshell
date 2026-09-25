import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { DiscoveryError, endpointsFromDocument, fetchDiscoveryDocument } from "@/auth/oidc-discovery.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";

/** POST /api/auth-providers/test body — the in-dialog probe; saves nothing. */
const TestProviderSchema = t.Object({
  issuer: t.String({ description: "OIDC issuer URL to run discovery against" }),
  clientId: t.Optional(
    t.String({ description: "Optional client id for the soft token-endpoint probe; never echoed back" }),
  ),
  clientSecret: t.Optional(
    t.String({
      description: "Optional client secret for the soft token-endpoint probe; never echoed back, never logged",
    }),
  ),
});

const TestEndpointsSchema = t.Object({
  authorizationUrl: t.String({ description: "Discovery's authorization_endpoint" }),
  tokenUrl: t.String({ description: "Discovery's token_endpoint" }),
  userInfoUrl: t.Nullable(t.String({ description: "Discovery's userinfo_endpoint, null when absent" })),
});

/** POST /api/auth-providers/test response (spec §8). */
const TestProviderResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The probe passed; failures answer as 400 DISCOVERY_FAILED instead" }),
  endpoints: TestEndpointsSchema,
  note: t.Optional(
    t.String({
      description:
        "The soft signal: sent when credentials were offered but the token endpoint does not advertise the client_credentials grant (Google does not), so discovery-verified is the honest ceiling",
    }),
  ),
});

/**
 * `POST /api/auth-providers/test` — runs OIDC discovery against an issuer
 * without saving anything (cookie-admin only). With credentials it also
 * attempts one client-credentials token fetch when the issuer advertises the
 * grant; when it does not (Google), discovery-verified is the answer with a
 * note. No credential ever appears in the response.
 */
export const testProviderRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/test",
    async ({ body, status }) => {
      const issuer = body.issuer.trim();
      if (issuer === "") {
        return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Issuer is required." }));
      }
      // The RAW document, not just the triple: the soft signal reads
      // grant_types_supported off it (spec §8).
      let doc: Record<string, unknown>;
      let endpoints;
      try {
        doc = await fetchDiscoveryDocument(issuer);
        endpoints = endpointsFromDocument(doc);
      } catch (err) {
        if (err instanceof DiscoveryError) {
          return status(
            400,
            apiErrorBody({ code: BackendErrorCodes.DISCOVERY_FAILED, message: `Discovery failed: ${err.reason}.` }),
          );
        }
        throw err;
      }
      const clientId = body.clientId?.trim() ?? "";
      const clientSecret = body.clientSecret ?? "";
      if (clientId !== "" && clientSecret !== "") {
        const grantTypes = Array.isArray(doc.grant_types_supported)
          ? doc.grant_types_supported.filter((g): g is string => typeof g === "string")
          : [];
        if (grantTypes.includes("client_credentials")) {
          // The soft hard-signal: real credentials, one token request. Its
          // BODY is never echoed and never logged — a failure names the
          // status only.
          try {
            const res = await fetch(endpoints.tokenUrl, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
              return status(
                400,
                apiErrorBody({
                  code: BackendErrorCodes.DISCOVERY_FAILED,
                  message: `The token endpoint refused the client credentials (HTTP ${res.status}).`,
                }),
              );
            }
          } catch {
            return status(
              400,
              apiErrorBody({
                code: BackendErrorCodes.DISCOVERY_FAILED,
                message: "The token endpoint could not be reached.",
              }),
            );
          }
        } else {
          // Google's shape: the grant is not offered, so discovery-verified is
          // the honest ceiling the note tells the admin (spec §8).
          return { ok: true, endpoints, note: "token-endpoint grant not offered; discovery verified" } as const;
        }
      }
      return { ok: true, endpoints } as const;
    },
    {
      body: TestProviderSchema,
      response: {
        200: TestProviderResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "testAuthProvider",
        tags: ["auth-providers"],
        description:
          "Runs OIDC discovery against an issuer without saving anything (cookie-admin only). With credentials it also attempts one client-credentials token fetch when the issuer advertises the grant; when it does not (Google), discovery-verified is the answer with a note. No credential ever appears in the response",
      },
    },
  );
