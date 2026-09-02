import { ForbiddenError, type GuardActor } from "@/api/auth-guard.js";

/**
 * Every `/api/workspaces` endpoint is a browser-only surface: the `mote mcp`
 * binary calls exactly `/api/sessions…`, `/api/channels…`, `/api/profiles`
 * (GET), `/api/identities` (POST) and `…/extend-token` — never workspaces
 * (census: `packages/mcp-core/src/tools.ts` + `packages/mcp-core/src/server.ts` `deps.api.req` calls),
 * and the frontend reaches these cookie-only through `apiFetch`
 * (`credentials: "include"`).
 *
 * F4 (security audit 2026-08): until now these routes ran under bare
 * `authGuard`, so a bearer key — even a zero-grant session token, which
 * `requirePerm` never sees on these routes — acted as its OWNER here. Since
 * no machine consumer exists, machine actors (session or system keys) are
 * refused with 403, following the cookie-only pattern of
 * `profiles.route.ts` / `settings.route.ts` (commit d56bc2e).
 *
 * @param actor - the authGuard-derived actor for the request
 * @throws ForbiddenError (403) for any non-cookie actor
 */
export function requireCookieActor(actor: GuardActor | undefined): void {
  if (actor !== "cookie") throw new ForbiddenError();
}
