import { Elysia } from "elysia";
import { createProviderRoute } from "@/api/auth-providers/create-provider.route.js";
import { deleteProviderRoute } from "@/api/auth-providers/delete-provider.route.js";
import { listProvidersRoute } from "@/api/auth-providers/list-providers.route.js";
import { patchProviderRoute } from "@/api/auth-providers/patch-provider.route.js";
import { testProviderRoute } from "@/api/auth-providers/test-provider.route.js";

/**
 * `/api/auth-providers` — admin CRUD for the sign-in doors (`auth_providers`,
 * spec 2026-09-24 §8), one Elysia instance per endpoint mounted in the
 * original monolithic route's order. Cookie-admin only — these rows decide who
 * can sign into the instance, so a machine credential managing them is the
 * exact loop the admin rule exists to break. Each module composes
 * `requireAdmin` itself, so all five verbs answer through it: an anonymous
 * request 401s at authGuard, a member cookie or any bearer 403s at the
 * guard's derive. Three invariants the handlers own:
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
export const authProvidersRoutes = new Elysia({ prefix: "/api/auth-providers" })
  .use(listProvidersRoute)
  .use(createProviderRoute)
  .use(patchProviderRoute)
  .use(deleteProviderRoute)
  // `/test` sits after the `/:id` verbs for reading order only; Elysia
  // matches by path RANK (static segments beat `/:id`), so the two cannot
  // shadow each other.
  .use(testProviderRoute);
