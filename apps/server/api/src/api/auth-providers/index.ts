import { Elysia } from "elysia";
import { createProviderRoute } from "@/api/auth-providers/create-provider.route.js";
import { deleteProviderRoute } from "@/api/auth-providers/delete-provider.route.js";
import { listProvidersRoute } from "@/api/auth-providers/list-providers.route.js";
import { patchProviderRoute } from "@/api/auth-providers/patch-provider.route.js";

/**
 * `/api/auth-providers` — admin CRUD for the sign-in providers (`auth_providers`,
 * spec 2026-09-24 §8), one Elysia instance per endpoint mounted in the
 * original monolithic route's order. Cookie-admin only — these rows decide who
 * can sign into the instance, so a machine credential managing them is the
 * exact loop the admin rule exists to break. Each module composes
 * `requireAdmin` itself, so all four verbs answer through it: an anonymous
 * request 401s at authGuard, a member cookie or any bearer 403s at the
 * guard's derive. Three invariants the handlers own:
 *
 * - The secret never leaves. GET answers `hasSecret`; audit rows carry field
 *   NAMES and the issuer only; the token probe never echoes what it was given.
 * - VERIFICATION is a SAVE gate, not a build dependency and not a separate
 *   probe route (operator ruling 2026-09-25, which deleted `POST /test`):
 *   discovery and, where the issuer advertises the grant, one real token
 *   request run at create and at any issuer/credential change (400
 *   `DISCOVERY_FAILED` / `CREDENTIALS_REJECTED` otherwise), endpoints are
 *   stored, and every later rebuild runs offline against the stored set.
 * - The last-provider guard: no write may leave `openSignInProviderCount()` at zero.
 *   The count includes the email row — it is a provider like any other to the
 *   repository; what is special about it lives here (kind immutable,
 *   undeletable).
 *
 * Expected failures are RETURNED with `status()` + `apiErrorBody()` rather
 * than thrown: the global handler's status→code reverse map would replace the
 * named codes (SLUG_TAKEN, LAST_SIGN_IN_PROVIDER, …) the SPA branches on.
 */
export const authProvidersRoutes = new Elysia({ prefix: "/api/auth-providers" })
  .use(listProvidersRoute)
  .use(createProviderRoute)
  .use(patchProviderRoute)
  .use(deleteProviderRoute);
