import { Elysia } from "elysia";
import { createSubshellRoute } from "@/api/subshells/create-subshell.route.js";
import { deleteSubshellRoute } from "@/api/subshells/delete-subshell.route.js";
import { execSubshellRoute } from "@/api/subshells/exec-subshell.route.js";
import { extendSubshellTokenRoute } from "@/api/subshells/extend-subshell-token.route.js";
import { getSubshellRoute } from "@/api/subshells/get-subshell.route.js";
import { getSubshellLogRoute } from "@/api/subshells/get-subshell-log.route.js";
import { inputSubshellRoute } from "@/api/subshells/input-subshell.route.js";
import { listSubshellsRoute } from "@/api/subshells/list-subshells.route.js";
import { restartSubshellRoute } from "@/api/subshells/restart-subshell.route.js";
import { sshPaneOpsRoutes } from "@/api/subshells/ssh-pane-ops.route.js";
import { subshellAttentionRoute } from "@/api/subshells/subshell-attention.route.js";
import { subshellExitRoute } from "@/api/subshells/subshell-exit.route.js";
import { subshellHarnessSessionRoute } from "@/api/subshells/subshell-harness-session.route.js";
import { subshellSharesRoutes } from "@/api/subshells/subshell-shares.route.js";
import { summarySubshellRoute } from "@/api/subshells/summary-subshell.route.js";
import { terminateSubshellRoute } from "@/api/subshells/terminate-subshell.route.js";
import { updateSubshellNameRoute } from "@/api/subshells/update-subshell-name.route.js";
import { updateSubshellNotifyRoute } from "@/api/subshells/update-subshell-notify.route.js";

/**
 * The three HARNESS SELF-REPORT doors (`attention`, `harness-session`, `exit`
 * - "a harness reports about itself", security-context's exact trio), grouped
 * into one sub-aggregate. The grouping is structural, not stylistic: Elysia's
 * composed type is a LEFT-NESTED merge, so flattening these three onto the
 * main chain and adding the SSH pane-ops door pushed `App =
 * ReturnType<typeof createApp>` past TypeScript's instantiation-depth ceiling
 * (TS2589) - exactly the trap `api/routes.ts` documents and answers with
 * balanced sub-aggregates. Nesting this trio into a side basket costs the main
 * chain one merge instead of three, and the endpoints and their types are
 * untouched.
 */
const selfReportRoutes = new Elysia()
  .use(subshellAttentionRoute)
  .use(subshellHarnessSessionRoute)
  .use(subshellExitRoute);

/**
 * `/api/subshells` — one Elysia instance per endpoint, mounted in the original
 * monolithic route's order (convention, not a router constraint: Elysia ranks
 * static segments above `/:id` regardless of order). Business logic lives in
 * `SubshellsService` (`src/services/subshells.service.ts`), reached by handlers
 * via `ctx`.
 */
export const subshellRoutes = new Elysia({ prefix: "/api/subshells" })
  .use(createSubshellRoute)
  .use(listSubshellsRoute)
  .use(summarySubshellRoute)
  .use(getSubshellRoute)
  .use(getSubshellLogRoute)
  .use(subshellSharesRoutes)
  .use(updateSubshellNotifyRoute)
  .use(selfReportRoutes)
  .use(updateSubshellNameRoute)
  .use(inputSubshellRoute)
  .use(execSubshellRoute)
  .use(sshPaneOpsRoutes)
  .use(restartSubshellRoute)
  .use(terminateSubshellRoute)
  .use(extendSubshellTokenRoute)
  .use(deleteSubshellRoute);
