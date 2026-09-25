import { BackendErrorCodes } from "@internal/backend-errors";
import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { b2n, PatchProviderSchema } from "@/api/auth-providers/provider-fields.js";
import { LAST_PROVIDER_MESSAGE, normalizeOriginList, PROVIDER_NAME_MAX } from "@/api/auth-providers/provider-inputs.js";
import { domainsInput, ProviderViewSchema, toView } from "@/api/auth-providers/provider-view.js";
import { EntryInputError, normalizeDomains, verifyOnSave } from "@/auth/oidc-discovery.js";
import { invalidateAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import type { AuthProviderRow } from "@/db/types/auth-providers.db-types.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/**
 * `PATCH /api/auth-providers/:id` — changes one provider (cookie-admin only).
 * id and kind are immutable; a change to issuer, client id or secret re-runs
 * the FULL verification (discovery plus the credential check — the save is
 * the verification, operator ruling 2026-09-25) and the save is refused with
 * 400 DISCOVERY_FAILED / CREDENTIALS_REJECTED when it fails; an empty
 * allowedDomains clears the list to any-domain. Refused with 409
 * LAST_SIGN_IN_PROVIDER when it would close the last open way to sign in.
 */
export const patchProviderRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .patch(
    "/:id",
    async ({ params, body, user, status }) => {
      const repo = new AuthProvidersRepository(db);
      const row = await repo.getById(params.id);
      if (!row) {
        return status(
          404,
          apiErrorBody({ code: BackendErrorCodes.PROVIDER_NOT_FOUND, message: `No auth provider "${params.id}".` }),
        );
      }
      // id/kind are immutable on every row; the email row's kind refusal
      // carries its own code because it is the row the guard belongs to.
      if (body.kind !== undefined) {
        return status(
          400,
          apiErrorBody({
            code: row.kind === "email" ? BackendErrorCodes.EMAIL_ROW_IMMUTABLE_KIND : BackendErrorCodes.BAD_REQUEST,
            message: "A provider's kind is immutable; delete it and add another.",
          }),
        );
      }
      if (body.id !== undefined && body.id !== params.id) {
        return status(
          400,
          apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "A provider's id is immutable." }),
        );
      }
      // The E-mail row has no OAuth identity (spec §2): issuer, clientId and
      // entryOrigins describe an exchange that row never runs. The route used
      // to accept them on this row — and a bogus issuer even earned a
      // discovery probe (refused before any fetch here). Create already 400s
      // `kind: "email"` wholesale, so this guard lives on the PATCH path.
      if (
        row.kind === "email" &&
        (body.issuer !== undefined ||
          body.clientId !== undefined ||
          body.clientSecret !== undefined ||
          body.entryOrigins !== undefined)
      ) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message:
              "The E-mail provider has no issuer, client id, client secret or entry origins. Those fields describe OIDC providers.",
          }),
        );
      }
      const patch: Partial<Omit<AuthProviderRow, "id" | "kind">> = {};
      const changed: string[] = [];

      if (body.name !== undefined) {
        const name = normalizeLabel(body.name, PROVIDER_NAME_MAX);
        if (name === "") {
          return status(
            400,
            apiErrorBody({
              code: BackendErrorCodes.BAD_REQUEST,
              message: "Name is required (nothing printable remains after normalization).",
            }),
          );
        }
        patch.name = name;
        changed.push("name");
      }

      const issuerChanged = body.issuer !== undefined && body.issuer.trim() !== "" && body.issuer.trim() !== row.issuer;
      const clientIdChanged = body.clientId !== undefined && body.clientId !== "" && body.clientId !== row.clientId;
      if (body.issuer !== undefined) {
        const issuer = body.issuer.trim();
        if (issuer === "") {
          return status(
            400,
            apiErrorBody({
              code: BackendErrorCodes.BAD_REQUEST,
              message: "An OIDC provider cannot have its issuer cleared.",
            }),
          );
        }
        patch.issuer = issuer;
        changed.push("issuer");
      }
      if (body.clientId !== undefined) {
        const clientId = body.clientId.trim();
        if (clientId === "") {
          return status(
            400,
            apiErrorBody({
              code: BackendErrorCodes.BAD_REQUEST,
              message: "An OIDC provider cannot have its client id cleared.",
            }),
          );
        }
        patch.clientId = clientId;
        changed.push("clientId");
      }
      // A secret is only ever REPLACED, never cleared: the schema rejects a
      // null (the SPA's contract), "" means leave the stored one, and a
      // non-empty string stores over it. "Clear the secret" would be the
      // broken-provider-by-save state (spec §8).
      const storeSecret = body.clientSecret !== undefined && body.clientSecret !== "";
      if (storeSecret) {
        patch.clientSecret = body.clientSecret;
        changed.push("clientSecret");
      }
      // Identity of the OAuth exchange changed ⇒ the pair must VERIFY against
      // the (possibly new) issuer before the row carries any of it — the save
      // IS the verification (operator ruling 2026-09-25), so a changed
      // secret alone triggers it too, not just a changed issuer or id. The
      // effective triple is what is checked: an unchanged half keeps its
      // stored value. A re-verify REPLACES the endpoints even when only the
      // credentials moved — the endpoints always describe the issuer the
      // check just reached.
      const verifyNeeded = issuerChanged || clientIdChanged || storeSecret;
      if (verifyNeeded && row.kind !== "email") {
        const vIssuer = body.issuer !== undefined ? body.issuer.trim() : row.issuer;
        if (vIssuer === null || vIssuer === "") {
          return status(
            400,
            apiErrorBody({
              code: BackendErrorCodes.BAD_REQUEST,
              message: "This provider has no issuer to run discovery against.",
            }),
          );
        }
        // A stored null client id means the row never had credentials to
        // check; `verifyOnSave` reads "" as exactly that and answers with
        // discovery alone.
        const vClientId = (body.clientId !== undefined ? body.clientId.trim() : row.clientId) ?? "";
        const vSecret = storeSecret ? (body.clientSecret as string) : (row.clientSecret ?? "");
        const check = await verifyOnSave(vIssuer, vClientId, vSecret);
        if (!check.ok) {
          return status(
            400,
            apiErrorBody({
              code:
                check.stage === "discovery"
                  ? BackendErrorCodes.DISCOVERY_FAILED
                  : BackendErrorCodes.CREDENTIALS_REJECTED,
              message: check.message,
            }),
          );
        }
        patch.endpointsJson = JSON.stringify(check.endpoints);
        changed.push("endpoints");
      }
      if (body.entryOrigins !== undefined) {
        try {
          const origins = normalizeOriginList(body.entryOrigins);
          patch.entryOrigins = JSON.stringify(origins);
          changed.push("entryOrigins");
        } catch (err) {
          if (err instanceof EntryInputError) {
            return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: err.message }));
          }
          throw err;
        }
      }
      if (body.allowedDomains !== undefined) {
        try {
          const domains = normalizeDomains(domainsInput(body.allowedDomains));
          // An empty list is NULL — "any domain" — never a column holding
          // "" (the dialog sends "" when the field is cleared).
          patch.allowedDomains = domains.length > 0 ? domains.join(",") : null;
          changed.push("allowedDomains");
        } catch (err) {
          if (err instanceof EntryInputError) {
            return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: err.message }));
          }
          throw err;
        }
      }
      const booleanField = <K extends "enabled" | "signInEnabled" | "registrationEnabled" | "requireApproval">(
        key: K,
      ): void => {
        const value = body[key];
        if (value !== undefined) {
          patch[key] = b2n(value);
          changed.push(key);
        }
      };
      booleanField("enabled");
      booleanField("signInEnabled");
      booleanField("registrationEnabled");
      booleanField("requireApproval");

      // The guard and the write are ONE transaction in the repository (the
      // setRole precedent): a count read here followed by a separate write
      // would let two admins closing two different providers both pass on the
      // same snapshot and land the instance at zero open providers. The route
      // only says what the row's post-patch open state would be; the count
      // arithmetic and the row re-read happen inside the transaction.
      const nextOpen = (body.enabled ?? row.enabled === 1) && (body.signInEnabled ?? row.signInEnabled === 1);
      const outcome = await repo.patchGuardingLastProvider(params.id, patch, nextOpen);
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
      invalidateAuth();
      await audit({
        actorUserId: user.id,
        action: "auth_provider.update",
        targetType: "auth_provider",
        targetId: params.id,
        metadataJson: JSON.stringify({ fields: changed, issuer: patch.issuer ?? row.issuer }),
      });
      const after = await repo.getById(params.id);
      if (!after) throw new Error(`auth_providers row ${params.id} vanished after update`);
      return toView(after);
    },
    {
      params: t.Object({ id: t.String({ description: "Id slug of the provider to change" }) }),
      body: PatchProviderSchema,
      response: {
        200: ProviderViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "patchAuthProvider",
        tags: ["auth-providers"],
        description:
          "Changes one provider (cookie-admin only). id and kind are immutable; a change to issuer, client id or secret re-runs the full verification (discovery plus the credential check where the issuer offers the grant) and the save is refused when it fails; an empty allowedDomains clears the list to any-domain. Refused with 409 LAST_SIGN_IN_PROVIDER when it would close the last open way to sign in",
      },
    },
  );
