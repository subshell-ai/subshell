import { Elysia } from "elysia";
import { sshAliasesRoute } from "@/api/ssh/aliases.route.js";
import { sshGrantRequestsRoutes } from "@/api/ssh/approvals.route.js";
import { sshGrantsRoutes } from "@/api/ssh/grants.route.js";
import { sshLaunchRoute } from "@/api/ssh/launch.route.js";
import { sshResolveRoute } from "@/api/ssh/resolve.route.js";
import { sshSavedHostsRoutes } from "@/api/ssh/saved-hosts.route.js";
import { sshSetupHereRoute } from "@/api/ssh/setup-here.route.js";
import { sshTrustRoutes } from "@/api/ssh/trust.route.js";

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
  .use(sshSavedHostsRoutes)
  // The grant tier (spec 2026-10-08 §6-§8, Task 10): the standing grants and
  // the first-use approval queue. Mounted INSIDE this group on purpose: a new
  // top-level `.route()` tier is the Elysia App-type-depth trap, and these
  // are the launcher's own authorization surface.
  .use(sshGrantsRoutes)
  .use(sshGrantRequestsRoutes)
  // The host-key pin trust screen (spec 2026-10-08 §8-§9, Task 12): the TOFU
  // pins a relay launch verifies D against. Mounted inside this group for the
  // same Elysia App-type-depth reason the grant tier is; these are the
  // grant layer's destination-trust half.
  .use(sshTrustRoutes)
  // The destination upgrade (spec 2026-10-08 §7, Task 14): "Set up Subshell
  // here" turns an open pane's destination into an enrolled node. Mounted
  // inside this group like every other ssh tier (App-type-depth rule); it is
  // the launcher's own act on the launcher's own pane.
  .use(sshSetupHereRoute);
