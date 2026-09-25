import { ForbiddenError, type GuardActor } from "@/api/auth-guard.js";

/**
 * Every `/api/workspaces` endpoint is a browser-only surface: the `subshell mcp`
 * binary calls exactly `/api/subshells…`, `/api/nodes` (GET), `/api/channels…`,
 * `/api/presets` (GET), `/api/plugins` (GET), `/api/identities` (POST) and
 * `…/extend-token`, never workspaces
 * (census: `packages/mcp-core/src/subshell-tools.ts` + `channel-tools.ts` + `server.ts` req calls),
 * and the frontend reaches these cookie-only through `apiFetch`
 * (`credentials: "include"`).
 *
 * F4 (security audit 2026-08): until now these routes ran under bare
 * `authGuard`, so a bearer key — even a zero-grant subshell token, which
 * `requirePerm` never sees on these routes — acted as its OWNER here. Since
 * no machine consumer exists, machine actors (subshell or system keys) are
 * refused with 403, following the cookie-only pattern of
 * `presets.route.ts` / `settings.route.ts` (commit d56bc2e).
 *
 * @param actor - the authGuard-derived actor for the request
 * @throws ForbiddenError (403) for any non-cookie actor
 */
export function requireCookieActor(actor: GuardActor | undefined): void {
  if (actor !== "cookie") throw new ForbiddenError();
}
