import { BackendErrorCodes } from "@internal/backend-errors";
import { normalizeLabel } from "@internal/subshell-protocol";
import { Elysia } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { b2n, CreateProviderFieldsSchema } from "@/api/auth-providers/provider-fields.js";
import { normalizeOriginList, PROVIDER_NAME_MAX } from "@/api/auth-providers/provider-inputs.js";
import { domainsInput, ProviderViewSchema, toView } from "@/api/auth-providers/provider-view.js";
import {
  EntryInputError,
  normalizeDomains,
  normalizeEntryOrigin,
  slugifyProviderId,
  verifyOnSave,
} from "@/auth/oidc-discovery.js";
import { invalidateAuth } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/**
 * `POST /api/auth-providers` — adds an OIDC sign-in provider (cookie-admin
 * only). The SAVE verifies (2026-09-25): discovery must resolve the issuer
 * and, when the issuer advertises the client_credentials grant, the token
 * endpoint must accept the offered pair — refusals answer 400
 * DISCOVERY_FAILED / CREDENTIALS_REJECTED and nothing is written. The id slug
 * is refused with 409 SLUG_TAKEN when taken. A fresh row can never trip the
 * last-open-provider guard.
 */
export const createProviderRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/",
    async ({ body, user, status }) => {
      const repo = new AuthProvidersRepository(db);
      if (body.kind === "email") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.EMAIL_ROW_IMMUTABLE_KIND,
            message: "The E-mail provider already exists as the reserved credential row; it cannot be created.",
          }),
        );
      }
      // The shared label normalizer, not a bare trim (final review, minor):
      // the name renders verbatim on the anonymous login buttons and inside
      // `heldEmailMessage`, and it is the one row column that reaches the
      // pre-auth surface — so it pays the rule every other NAME path pays.
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
      const issuer = body.issuer?.trim() ?? "";
      const clientId = body.clientId?.trim() ?? "";
      const clientSecret = body.clientSecret ?? "";
      if (issuer === "" || clientId === "" || clientSecret === "") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "An OIDC provider needs an issuer, a client id and a client secret.",
          }),
        );
      }
      // The id is REQUIRED on create and never silently derived from the
      // name: the dialog sends its slug preview, so what the admin saw in the
      // copy panel is what is stored. It still passes through the same
      // slugify pass, which validates the grammar (and refuses the reserved
      // `email` id); the existence check below covers any other collision.
      const rawId = body.id?.trim() ?? "";
      if (rawId === "") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "A provider id is required (the create dialog sends its slug preview).",
          }),
        );
      }
      // The reserved credential-provider id is the collision it is: the row
      // EXISTS, so the answer is 409 SLUG_TAKEN naming the reservation —
      // not the generic grammar 400 below, and not a normalization.
      if (rawId === "email") {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.SLUG_TAKEN,
            message: '"email" is the reserved id of the credential provider; pick another.',
          }),
        );
      }
      let id: string;
      try {
        id = slugifyProviderId(rawId);
      } catch (err) {
        if (err instanceof EntryInputError) {
          return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: err.message }));
        }
        throw err;
      }
      // The sent id must ALREADY be its slug: uppercase, commas and other
      // characters are refused, never silently normalized. The comma rule is
      // load-bearing beyond aesthetics — the roster's `providers` column is a
      // comma-joined list (Task 9's GROUP_CONCAT contract), and the id is a
      // callback path segment; the dialog's preview already lowercases and
      // dash-replaces, so a strict id is what it always sends.
      if (id !== rawId) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: `A provider id must already be a slug — lowercase [a-z0-9-], no commas or spaces (got "${rawId}").`,
          }),
        );
      }
      if (await repo.getById(id)) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.SLUG_TAKEN,
            message: `A provider with the id "${id}" already exists. Ids are the callback URL's identity and never move.`,
          }),
        );
      }
      // Discovery AND the credential check are the save gate (spec §3 + the
      // operator's ruling of 2026-09-25 that the save IS the verification —
      // the separate in-dialog probe route is gone), so nothing is written
      // first and a refusal costs the admin a retry, not a broken row.
      const check = await verifyOnSave(issuer, clientId, clientSecret);
      if (!check.ok) {
        return status(
          400,
          apiErrorBody({
            code:
              check.stage === "discovery" ? BackendErrorCodes.DISCOVERY_FAILED : BackendErrorCodes.CREDENTIALS_REJECTED,
            message: check.message,
          }),
        );
      }
      const endpoints = check.endpoints;
      // entryOrigins is required whenever the client sends the field — an
      // empty list is a refusal, never a silent default. Omitting it entirely
      // is the one case the instance's own origin stands in for (spec §5a).
      if (body.entryOrigins !== undefined && body.entryOrigins.length === 0) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "entryOrigins must carry at least one origin; omit the field to default to this instance.",
          }),
        );
      }
      let origins: string[];
      let domains: string[];
      try {
        origins = normalizeOriginList(body.entryOrigins ?? [normalizeEntryOrigin(APP_BASE_URL)]);
        domains = normalizeDomains(domainsInput(body.allowedDomains ?? ""));
      } catch (err) {
        if (err instanceof EntryInputError) {
          return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: err.message }));
        }
        throw err;
      }
      await repo.create({
        id,
        kind: body.kind,
        name,
        issuer,
        clientId,
        clientSecret,
        endpointsJson: JSON.stringify(endpoints),
        entryOrigins: JSON.stringify(origins),
        allowedDomains: domains.length > 0 ? domains.join(",") : null,
        enabled: b2n(body.enabled),
        signInEnabled: b2n(body.signInEnabled),
        // OIDC rows carry an explicit 0/1 (spec §2); the NULL legacy gate is
        // the email row's alone and create already refused that kind.
        registrationEnabled: b2n(body.registrationEnabled ?? false),
        requireApproval: b2n(body.requireApproval),
      });
      invalidateAuth();
      await audit({
        actorUserId: user.id,
        action: "auth_provider.create",
        targetType: "auth_provider",
        targetId: id,
        // Field NAMES and the issuer only — never values, never the secret.
        metadataJson: JSON.stringify({ fields: Object.keys(body), issuer }),
      });
      const row = await repo.getById(id);
      // The row was just inserted; its absence means the table changed under
      // us between write and read — a genuinely impossible state, not a 404.
      if (!row) throw new Error(`auth_providers row ${id} vanished after create`);
      return toView(row);
    },
    {
      body: CreateProviderFieldsSchema,
      response: {
        200: ProviderViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createAuthProvider",
        tags: ["auth-providers"],
        description:
          "Adds an OIDC sign-in provider (cookie-admin only). The save runs the verification: discovery must resolve the issuer, and where the issuer advertises client_credentials the token endpoint must accept the pair (400 DISCOVERY_FAILED / CREDENTIALS_REJECTED, nothing written). The id slug is refused with 409 SLUG_TAKEN when taken",
      },
    },
  );
