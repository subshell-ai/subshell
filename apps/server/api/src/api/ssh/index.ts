import { Elysia } from "elysia";
import { sshAliasesRoute } from "@/api/ssh/aliases.route.js";
import { sshLaunchRoute } from "@/api/ssh/launch.route.js";
import { sshResolveRoute } from "@/api/ssh/resolve.route.js";
import { sshSavedHostsRoutes } from "@/api/ssh/saved-hosts.route.js";
import { sshSetupHereRoute } from "@/api/ssh/setup-here.route.js";
import { sshTrustRoutes } from "@/api/ssh/trust.route.js";
import { sshIdentitiesRoute } from "./identities.route.js";
import { sshReadinessRoute } from "./readiness.route.js";

/** Cookie-only SSH operations, readiness, destination ledger and trust. */
export const sshRoutes = new Elysia({ prefix: "/api/ssh" })
  .use(sshReadinessRoute)
  .use(sshIdentitiesRoute)
  .use(sshAliasesRoute)
  .use(sshResolveRoute)
  .use(sshLaunchRoute)
  .use(sshSavedHostsRoutes)
  .use(sshTrustRoutes)
  // The destination upgrade (spec 2026-10-08 §7, Task 14): "Set up Subshell
  // here" turns an open pane's destination into an enrolled node. Mounted
  // inside this group like every other ssh tier (App-type-depth rule); it is
  // the launcher's own act on the launcher's own pane.
  .use(sshSetupHereRoute);
