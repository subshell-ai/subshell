import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, requireAdmin } from "@/api/auth-guard.js";
import {
  DiscoveryError,
  EntryInputError,
  endpointsFromDocument,
  fetchDiscoveryDocument,
  normalizeDomains,
  normalizeEntryOrigin,
  resolveEndpoints,
  slugifyProviderId,
} from "@/auth/oidc-discovery.js";
import { invalidateAuth } from "@/auth.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { type AuthProviderRow, asProviderKind } from "@/db/types/auth-providers.db-types.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/**
 * Admin CRUD for the sign-in doors (`auth_providers`, spec 2026-09-24 §8).
 * Cookie-admin only — these rows decide who can sign into the instance, so a
 * machine credential managing them is the exact loop the admin rule exists to
 * break. Three invariants the handlers own:
 *
 * - The secret never leaves. GET answers `hasSecret`; audit rows carry field
 *   NAMES and the issuer only; the probe never echoes what it was given.
 * - Discovery is a SAVE gate, not a build dependency: endpoints are resolved
 *   and stored here (400 `DISCOVERY_FAILED` otherwise), and every later
 *   rebuild runs offline against the stored pair.
 * - The last-door guard: no write may leave `openSignInDoorCount()` at zero.
 *   The count includes the email row — it is a door like any other to the
 *   repository; what is special about it lives here (kind immutable,
 *   undeletable).
 *
 * Expected failures are RETURNED with `status()` + `apiErrorBody()` rather
 * than thrown: the global handler's status→code reverse map would replace the
 * named codes (SLUG_TAKEN, LAST_SIGN_IN_DOOR, …) the SPA branches on.
 */

const ProviderKindSchema = t.Union([t.Literal("email"), t.Literal("google"), t.Literal("oidc")], {
  description:
    'Door kind: the reserved "email" credential row, or an OIDC/genericOAuth door ("google" is the preset id, driven the same way)',
});

/** One door as the admin list serves it — spec §8: the secret is NOT here. */
const ProviderViewSchema = t.Object({
  id: t.String({ description: "Door id slug; the callback path segment, immutable after create" }),
  kind: ProviderKindSchema,
  name: t.String({ description: "Display name shown on the sign-in page" }),
  issuer: t.Nullable(t.String({ description: "OIDC issuer URL; null only on the email row" })),
  clientId: t.Nullable(t.String({ description: "OAuth client id; null only on the email row" })),
  hasSecret: t.Boolean({ description: "Whether a client secret is stored. Never the secret itself" }),
  entryOrigins: t.Array(t.String({ description: "Bare origin, canonical URL.origin spelling" }), {
    description:
      "Origins this door may be reached from; position 0 is canonical (spec §5a). Empty only on the email row",
  }),
  allowedDomains: t.Nullable(
    t.Array(t.String({ description: "One allowed e-mail domain, lowercase bare form" }), {
      description: "Allowed e-mail domains; null means any domain (spec §5)",
    }),
  ),
  enabled: t.Boolean({
    description: "Master switch: a disabled door does nothing, however open its half-switches are",
  }),
  signInEnabled: t.Boolean({ description: "Whether this door may sign accounts in" }),
  registrationEnabled: t.Nullable(
    t.Boolean({
      description:
        "Whether this door may create accounts; null is the legacy dynamic gate, legal only on the email row",
    }),
  ),
  requireApproval: t.Boolean({ description: "Whether accounts this door creates land on pending (spec §6)" }),
  endpointsResolved: t.Boolean({
    description: "Whether discovery endpoints were captured at save; drives the table's badge (spec §7)",
  }),
});

/** GET /api/auth-providers response. */
const ListResponseSchema = t.Object({
  providers: t.Array(ProviderViewSchema, {
    description: "Every door row, stored order (position, then id) — the email row first",
  }),
});

/** The POST body field set; PATCH is its Partial (id/kind immutable there). */
const CreateProviderFieldsSchema = t.Object({
  id: t.Optional(
    t.String({
      description:
        "Id slug to store. Defaults to the slugified name; the create dialog sends its own preview so the registration panel's prediction is the stored truth. Lowercase [a-z0-9-], at most 40 characters, and not the reserved email id",
    }),
  ),
  kind: ProviderKindSchema,
  name: t.String({ description: "Display name; trimmed, non-empty" }),
  issuer: t.Optional(
    t.String({ description: "OIDC issuer URL. Required for google/oidc kinds; discovery runs against it at save" }),
  ),
  clientId: t.Optional(t.String({ description: "OAuth client id. Required for google/oidc kinds" })),
  clientSecret: t.Optional(
    t.String({
      description:
        "OAuth client secret. Required for google/oidc kinds on create. On PATCH an empty string means leave the stored secret untouched; it is never read back, only replaced",
    }),
  ),
  entryOrigins: t.Optional(
    t.Array(t.String({ description: "One entry origin; http(s), bare host[:port], canonicalized to URL.origin" }), {
      description:
        "Origins this door is reached from. When none are sent, the instance's own APP_BASE_URL origin is used; position 0 is the canonical one the redirect URI is built from (spec §5a)",
    }),
  ),
  allowedDomains: t.Optional(
    t.Union(
      [
        t.String({ description: "Comma-separated e-mail domains" }),
        t.Array(t.String({ description: "One allowed e-mail domain, bare form" }), {
          description: "The domain list as an array",
        }),
      ],
      {
        description:
          "Allowed e-mail domains (spec §5), comma-separated string or array — the dialog sends either; both are normalized to lowercase bare form and deduped. An empty string or empty array CLEARS the column to NULL (= any domain), never a stored empty value",
      },
    ),
  ),
  enabled: t.Boolean({ description: "Master switch for this door" }),
  signInEnabled: t.Boolean({ description: "Whether this door may sign accounts in" }),
  registrationEnabled: t.Optional(
    t.Boolean({
      description:
        "Whether this door may create accounts. Omitted on create means false; OIDC rows always carry an explicit value (spec §2)",
    }),
  ),
  requireApproval: t.Boolean({ description: "Whether accounts created through this door land on pending (spec §6)" }),
});

/** PATCH /api/auth-providers/:id body: a partial of the create fields. */
const PatchProviderSchema = t.Partial(CreateProviderFieldsSchema);

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

/** DELETE /api/auth-providers/:id response — a body, not a bare 204: the SPA parses it. */
const DeleteResponseSchema = t.Object({
  ok: t.Literal(true, {
    description: "The door row is gone; users and accounts it once created are untouched (spec §7)",
  }),
});

const b2n = (value: boolean): number => (value ? 1 : 0);

/** Parse a stored JSON origin array defensively: a hand-corrupted column costs an empty list, never a 500. */
function parseStoredOrigins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Both accepted wire spellings of `allowed_domains` (comma string, array)
 * converge into the validator's comma form; domains cannot contain a comma
 * (the validator refuses the separator), so the join is lossless. */
function domainsInput(raw: string | string[]): string {
  return Array.isArray(raw) ? raw.join(",") : raw;
}

/** The stored comma list back to the view's array; "" (a hand edit) reads as null = any. */
function storedDomainsToView(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return null;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
}

function toView(row: AuthProviderRow) {
  return {
    id: row.id,
    kind: asProviderKind(row.kind),
    name: row.name,
    issuer: row.issuer,
    clientId: row.clientId,
    hasSecret: row.clientSecret !== null,
    entryOrigins: parseStoredOrigins(row.entryOrigins),
    allowedDomains: storedDomainsToView(row.allowedDomains),
    enabled: row.enabled === 1,
    signInEnabled: row.signInEnabled === 1,
    registrationEnabled: row.registrationEnabled === null ? null : row.registrationEnabled === 1,
    requireApproval: row.requireApproval === 1,
    endpointsResolved: row.endpointsJson !== null && row.endpointsJson !== "",
  };
}

/** The one refusal sentence every last-door guard shares (spec §8). */
const LAST_DOOR_MESSAGE =
  "This would leave no way to sign in. Open another door first, or use SUBSHELL_EMERGENCY_PASSWORD from the CLI.";

/** Normalize a submitted origin list; the caller has already decided a default exists. */
function normalizeOriginList(list: string[]): string[] {
  const seen: string[] = [];
  for (const entry of list) {
    const canonical = normalizeEntryOrigin(entry);
    if (!seen.includes(canonical)) seen.push(canonical);
  }
  if (seen.length === 0) {
    throw new EntryInputError("entry origins resolved to an empty list");
  }
  return seen;
}

// All verbs answer through requireAdmin: an anonymous request 401s at
// authGuard, a member cookie or any bearer 403s at the guard's derive.
export const authProvidersRoutes = new Elysia({ prefix: "/api/auth-providers" })
  .use(apiModels)
  .use(authGuard)
  .use(requireAdmin)
  .get("/", async () => ({ providers: (await new AuthProvidersRepository(db).listAll()).map(toView) }), {
    response: ListResponseSchema,
    detail: {
      operationId: "listAuthProviders",
      tags: ["auth-providers"],
      description:
        "Every auth provider row for the admin table (cookie-admin only). The client secret is never serialized; hasSecret says whether one is stored",
    },
  })
  .post(
    "/",
    async ({ body, user, status }) => {
      const repo = new AuthProvidersRepository(db);
      if (body.kind === "email") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.EMAIL_ROW_IMMUTABLE_KIND,
            message: "The email door already exists as the reserved credential row; it cannot be created.",
          }),
        );
      }
      const name = body.name.trim();
      if (name === "") {
        return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Name is required." }));
      }
      const issuer = body.issuer?.trim() ?? "";
      const clientId = body.clientId?.trim() ?? "";
      const clientSecret = body.clientSecret ?? "";
      if (issuer === "" || clientId === "" || clientSecret === "") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "An OIDC door needs an issuer, a client id and a client secret.",
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
      // The reserved credential-door id is the collision it is: the row
      // EXISTS, so the answer is 409 SLUG_TAKEN naming the reservation —
      // not the generic grammar 400 below, and not a normalization.
      if (rawId === "email") {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.SLUG_TAKEN,
            message: '"email" is the reserved id of the credential door; pick another.',
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
            message: `A door with the id "${id}" already exists. Ids are the callback URL's identity and never move.`,
          }),
        );
      }
      // Discovery is the save gate: an unreachable or endpoint-less issuer
      // cannot become a door at all (spec §3), so nothing is written first.
      let endpoints;
      try {
        endpoints = await resolveEndpoints(issuer);
      } catch (err) {
        if (err instanceof DiscoveryError) {
          return status(
            400,
            apiErrorBody({ code: BackendErrorCodes.DISCOVERY_FAILED, message: `Discovery failed: ${err.reason}.` }),
          );
        }
        throw err;
      }
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
          "Adds an OIDC sign-in door (cookie-admin only). Discovery must resolve the issuer's endpoints or the save is refused with 400 DISCOVERY_FAILED; the id slug is refused with 409 SLUG_TAKEN when taken. The new door is a fresh door, so the last-door guard can never refuse a create",
      },
    },
  )
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
            message: "A door's kind is immutable; delete it and add another.",
          }),
        );
      }
      if (body.id !== undefined && body.id !== params.id) {
        return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "A door's id is immutable." }));
      }
      const patch: Partial<Omit<AuthProviderRow, "id" | "kind">> = {};
      const changed: string[] = [];

      if (body.name !== undefined) {
        const name = body.name.trim();
        if (name === "") {
          return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Name is required." }));
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
              message: "An OIDC door cannot have its issuer cleared.",
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
              message: "An OIDC door cannot have its client id cleared.",
            }),
          );
        }
        patch.clientId = clientId;
        changed.push("clientId");
      }
      // A secret is only ever REPLACED, never cleared: the schema rejects a
      // null (the SPA's contract), "" means leave the stored one, and a
      // non-empty string stores over it. "Clear the secret" would be the
      // broken-door-by-save state (spec §8).
      const storeSecret = body.clientSecret !== undefined && body.clientSecret !== "";
      if (storeSecret) {
        patch.clientSecret = body.clientSecret;
        changed.push("clientSecret");
      }
      // Identity of the OAuth exchange changed ⇒ the endpoints must describe
      // the NEW issuer before the row carries it (spec §8's re-probe rule).
      if (issuerChanged || clientIdChanged) {
        const probeIssuer = body.issuer !== undefined ? body.issuer.trim() : row.issuer;
        if (probeIssuer === null || probeIssuer === "") {
          return status(
            400,
            apiErrorBody({
              code: BackendErrorCodes.BAD_REQUEST,
              message: "This door has no issuer to run discovery against.",
            }),
          );
        }
        try {
          patch.endpointsJson = JSON.stringify(await resolveEndpoints(probeIssuer));
          changed.push("endpoints");
        } catch (err) {
          if (err instanceof DiscoveryError) {
            return status(
              400,
              apiErrorBody({ code: BackendErrorCodes.DISCOVERY_FAILED, message: `Discovery failed: ${err.reason}.` }),
            );
          }
          throw err;
        }
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
      // would let two admins closing two different doors both pass on the
      // same snapshot and land the instance at zero open doors. The route
      // only says what the row's post-patch open state would be; the count
      // arithmetic and the row re-read happen inside the transaction.
      const nextOpen = (body.enabled ?? row.enabled === 1) && (body.signInEnabled ?? row.signInEnabled === 1);
      const outcome = await repo.patchGuardingLastDoor(params.id, patch, nextOpen);
      if (outcome === "last_door") {
        return status(409, apiErrorBody({ code: BackendErrorCodes.LAST_SIGN_IN_DOOR, message: LAST_DOOR_MESSAGE }));
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
      params: t.Object({ id: t.String({ description: "Id slug of the door to change" }) }),
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
          "Changes one door (cookie-admin only). id and kind are immutable; an issuer or client-id change re-runs discovery and the save is refused when discovery fails; an empty allowedDomains clears the list to any-domain. Refused with 409 LAST_SIGN_IN_DOOR when it would close the last open way to sign in",
      },
    },
  )
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
              "The email door can be closed but never deleted. Turn it off instead, and only while another door is open.",
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
      // pre-read above answers 404 and the audit's issuer, but the open-door
      // arithmetic must not trust a snapshot a concurrent write may move.
      const outcome = await repo.deleteGuardingLastDoor(params.id);
      if (outcome === "last_door") {
        return status(409, apiErrorBody({ code: BackendErrorCodes.LAST_SIGN_IN_DOOR, message: LAST_DOOR_MESSAGE }));
      }
      if (outcome === "not_found") {
        return status(
          404,
          apiErrorBody({ code: BackendErrorCodes.PROVIDER_NOT_FOUND, message: `No auth provider "${params.id}".` }),
        );
      }
      // Users and accounts the door created stay (spec §7) — deleting the
      // door removes the WAY in, not the people already in.
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
      params: t.Object({ id: t.String({ description: "Id slug of the door to delete" }) }),
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
          "Deletes a door (cookie-admin only). The reserved email row is refused with 400 EMAIL_ROW_UNDELETABLE, and deleting the only open door is refused with 409 LAST_SIGN_IN_DOOR. Accounts the door created are untouched",
      },
    },
  )
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
