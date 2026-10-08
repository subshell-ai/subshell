import { Elysia } from "elysia";
import { sshAliasesRoute } from "@/api/ssh/aliases.route.js";
import { sshLaunchRoute } from "@/api/ssh/launch.route.js";
import { sshResolveRoute } from "@/api/ssh/resolve.route.js";
import { sshSavedHostsRoutes } from "@/api/ssh/saved-hosts.route.js";

/**
 * `/api/ssh` — the launcher surface (spec 2026-10-07 §5/§7, plan 2 Task 7):
 * discovery, resolution, the gated launch, and the caller's own destination
 * ledger. One Elysia instance per endpoint file (the `api/nodes/` shape the
 * file-size rule grew this surface into), all cookie-actor, all gated through
 * `nodeCanSsh` over the plane's own node row BEFORE any machine is asked
 * anything — the refusal order is the contract, pinned in
 * `__tests__/ssh-routes.test.ts`.
 */
export const sshRoutes = new Elysia({ prefix: "/api/ssh" })
  .use(sshAliasesRoute)
  .use(sshResolveRoute)
  .use(sshLaunchRoute)
  .use(sshSavedHostsRoutes);
