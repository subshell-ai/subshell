import { Elysia } from "elysia";
import { sshCancelRunRoute } from "@/api/ssh/cancel-run.route.js";
import { sshCreateConnectionRoute } from "@/api/ssh/create-connection.route.js";
import { sshCreateTerminalRoute } from "@/api/ssh/create-terminal.route.js";
import { sshDeleteConnectionRoute } from "@/api/ssh/delete-connection.route.js";
import { sshDiscoveryRoute } from "@/api/ssh/discovery.route.js";
import { sshGetConnectionRoute } from "@/api/ssh/get-connection.route.js";
import { sshGetRunRoute } from "@/api/ssh/get-run.route.js";
import { sshGrantConnectionRoute } from "@/api/ssh/grant-connection.route.js";
import { sshListConnectionsRoute } from "@/api/ssh/list-connections.route.js";
import { sshListGrantsRoute } from "@/api/ssh/list-grants.route.js";
import { sshListRunsRoute } from "@/api/ssh/list-runs.route.js";
import { sshResolveConnectionRoute } from "@/api/ssh/resolve-connection.route.js";
import { sshRevokeGrantRoute } from "@/api/ssh/revoke-grant.route.js";
import { sshRunOutputRoute } from "@/api/ssh/run-output.route.js";
import { sshStartRunRoute } from "@/api/ssh/start-run.route.js";
import { sshTestConnectionRoute } from "@/api/ssh/test-connection.route.js";
import { sshUpdateConnectionRoute } from "@/api/ssh/update-connection.route.js";

/**
 * `/api/ssh` - the SSH REST family (SSH-SUPPORT.md §4's table, rows 1-5),
 * one endpoint per file, this module composition only. Every control decision
 * lives in `services/ssh/ssh-policy-impl.ts` behind the frozen `SshPolicy`
 * interface; the handlers here build the caller, run the explicit cookie-
 * write origin check, and serialize.
 *
 * `routes.ts` folds this basket into the app ONCE - the task-D report carries
 * the exact hunk (per the TS2589 rule it must join as its own sub-aggregate
 * level, not an extra `.use()` on the fullest existing group). The
 * `POST /api/subshells/:id/ssh-control` verb of §4's last row is NOT here: it
 * rides workstream C's pane routes and drives the registered takeover act in
 * `pane-ssh-gate.ts::transitionPaneControl` (node-first mirror + stream close
 * on the raise commit).
 */
export const sshRoutes = new Elysia({ prefix: "/api/ssh" })
  .use(sshDiscoveryRoute)
  .use(sshResolveConnectionRoute)
  .use(sshTestConnectionRoute)
  .use(sshCreateConnectionRoute)
  .use(sshListConnectionsRoute)
  .use(sshGetConnectionRoute)
  .use(sshUpdateConnectionRoute)
  .use(sshDeleteConnectionRoute)
  .use(sshListGrantsRoute)
  .use(sshGrantConnectionRoute)
  .use(sshRevokeGrantRoute)
  .use(sshStartRunRoute)
  .use(sshListRunsRoute)
  .use(sshGetRunRoute)
  .use(sshRunOutputRoute)
  .use(sshCancelRunRoute)
  .use(sshCreateTerminalRoute);
