import { Elysia } from "elysia";
import { createSubshellRoute } from "@/api/subshells/create-subshell.route.js";
import { deleteSubshellRoute } from "@/api/subshells/delete-subshell.route.js";
import { extendSubshellTokenRoute } from "@/api/subshells/extend-subshell-token.route.js";
import { getSubshellRoute } from "@/api/subshells/get-subshell.route.js";
import { getSubshellLogRoute } from "@/api/subshells/get-subshell-log.route.js";
import { listSubshellsRoute } from "@/api/subshells/list-subshells.route.js";
import { restartSubshellRoute } from "@/api/subshells/restart-subshell.route.js";
import { subshellAttentionRoute } from "@/api/subshells/subshell-attention.route.js";
import { subshellHarnessSessionRoute } from "@/api/subshells/subshell-harness-session.route.js";
import { subshellSharesRoutes } from "@/api/subshells/subshell-shares.route.js";
import { summarySubshellRoute } from "@/api/subshells/summary-subshell.route.js";
import { terminateSubshellRoute } from "@/api/subshells/terminate-subshell.route.js";
import { updateSubshellNameRoute } from "@/api/subshells/update-subshell-name.route.js";
import { updateSubshellNotesRoute } from "@/api/subshells/update-subshell-notes.route.js";
import { updateSubshellNotifyRoute } from "@/api/subshells/update-subshell-notify.route.js";

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
  .use(updateSubshellNotesRoute)
  .use(updateSubshellNotifyRoute)
  .use(subshellAttentionRoute)
  .use(subshellHarnessSessionRoute)
  .use(updateSubshellNameRoute)
  .use(restartSubshellRoute)
  .use(terminateSubshellRoute)
  .use(extendSubshellTokenRoute)
  .use(deleteSubshellRoute);
