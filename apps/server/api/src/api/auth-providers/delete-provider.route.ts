import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { LAST_PROVIDER_MESSAGE } from "@/api/auth-providers/provider-inputs.js";
import { invalidateAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/** DELETE /api/auth-providers/:id response — a body, not a bare 204: the SPA parses it. */
const DeleteResponseSchema = t.Object({
  ok: t.Literal(true, {
    description: "The provider row is gone; users and accounts it once created are untouched (spec §7)",
  }),
});

/**
 * `DELETE /api/auth-providers/:id` — deletes a provider (cookie-admin only). The
 * reserved email row is refused with 400 EMAIL_ROW_UNDELETABLE, and deleting
 * the only open provider is refused with 409 LAST_SIGN_IN_PROVIDER. Accounts the provider
 * created are untouched.
 */
export const deleteProviderRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .delete(
    "/:id",
    async ({ params, user, status }) => {
      const repo = new AuthProvidersRepository(db);
      if (params.id === "email") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.EMAIL_ROW_UNDELETABLE,
            message:
              "The E-mail provider can be closed but never deleted. Turn it off instead, and only while another provider is open.",
          }),
        );
      }
      const row = await repo.getById(params.id);
      if (!row) {
        return status(
          404,
          apiErrorBody({ code: BackendErrorCodes.PROVIDER_NOT_FOUND, message: `No auth provider "${params.id}".` }),
        );
      }
      // Guard + delete in ONE transaction (the PATCH guard's shape): the
      // pre-read above answers 404 and the audit's issuer, but the open-provider
      // arithmetic must not trust a snapshot a concurrent write may move.
      const outcome = await repo.deleteGuardingLastProvider(params.id);
      if (outcome === "last_provider") {
        return status(
          409,
          apiErrorBody({ code: BackendErrorCodes.LAST_SIGN_IN_PROVIDER, message: LAST_PROVIDER_MESSAGE }),
        );
      }
      if (outcome === "not_found") {
        return status(
          404,
          apiErrorBody({ code: BackendErrorCodes.PROVIDER_NOT_FOUND, message: `No auth provider "${params.id}".` }),
        );
      }
      // Users and accounts the provider created stay (spec §7) — deleting the
      // provider removes the WAY in, not the people already in.
      invalidateAuth();
      await audit({
        actorUserId: user.id,
        action: "auth_provider.delete",
        targetType: "auth_provider",
        targetId: params.id,
        metadataJson: JSON.stringify({ fields: [], issuer: row.issuer }),
      });
      // 200 with a body, not a bare 204: the SPA's fetch parses JSON on every
      // success path and an empty 204 reads as a failed delete there.
      return { ok: true } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "Id slug of the provider to delete" }) }),
      response: {
        200: DeleteResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteAuthProvider",
        tags: ["auth-providers"],
        description:
          "Deletes a provider (cookie-admin only). The reserved email row is refused with 400 EMAIL_ROW_UNDELETABLE, and deleting the only open provider is refused with 409 LAST_SIGN_IN_PROVIDER. Accounts the provider created are untouched",
      },
    },
  );
