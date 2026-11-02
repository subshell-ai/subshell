import { Elysia, t } from "elysia";
import { authGuard, requireReportPerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { getPreviewBroker } from "@/modules/previews/preview-broker.js";
import { HttpError } from "@/shared/errors.js";
import { logger } from "@/shared/logger.js";

const ExitBodySchema = t.Object({
  exitCode: t.Optional(
    t.Union([t.Number(), t.Null()], {
      description:
        "The pane's exit status as tmux reported it (`#{pane_dead_status}`). Null or absent when it could not be read, never guessed at, since 0 is a real answer",
    }),
  ),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/**
 * `POST /api/subshells/:id/exit` — the pane reports its OWN death.
 *
 * A tmux `pane-died` hook re-enters the subshell binary the instant the
 * harness exits (spec 2026-09-19 §4.3), so a dashboard learns in about a
 * second instead of waiting out the 60 s reconcile sweep. The sweep stays as
 * the backstop — a hook can be missed (a `SIGKILL`ed tmux server, a machine
 * that lost power) — and both paths converge on the one death transition, so
 * whichever lands first wins and the other no-ops.
 *
 * Subshell-key-only and self-scoped, exactly like /attention and
 * /harness-session: a pane speaks for its own row and never another's, and a
 * browser has no reason to be here. The hook needs no new credential — it
 * authenticates with the pane's own, exactly as the harness hooks do — but
 * note WHERE those come from, because the obvious answer is wrong and was
 * written here once: a `run-shell` hook inherits the tmux SERVER's
 * environment, and the pane is launched through `env -i`, so the server holds
 * none of the pane's `SUBSHELL_*` (measured 2026-09-20). `exitHookFor` puts
 * them on the hook's own command line. Deleting that prefix would look
 * correct on any machine whose shell exports them.
 */
export const subshellExitRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/exit",
    async ({ params, body, actor, principal, apiKeyPermissions, ctx }) => {
      requireReportPerm({ actor, apiKeyPermissions });
      // The grant is scope-wide, not per-row: a pane holds this door for ITS
      // own subshell (report:write, or the subshells:write an MCP-enabled pane
      // carries), so the cross-row check lives here.
      if (actor !== "subshell-key" || principal !== `sess:${params.id}`) {
        throw new HttpError(403, "Only a subshell's own key may report its exit");
      }
      await ctx.services.subshells.reportExit(params.id, body.exitCode ?? null);
      // The pane is gone, so everything hanging off it goes too: every
      // forward lane, the screencast bridge, and the display-audit fact
      // (the broker files the display close through its own bookkeeping,
      // so the route never calls `onDisplayClosed` beside it). Best-effort
      // by design: the death row is already written, and a preview that
      // refuses to tear down must not turn the pane's own report into a 500.
      // This is the FAST path, not the only close: the shared death
      // transition (`#applyDeath`, where the sweep and the exit census
      // land) belts the same `closeForPane` for a dead pane, and the node's
      // link-drop pass still catches a whole node. The broker's close is
      // idempotent, so a fast path racing a belt audits one close, not two.
      try {
        await getPreviewBroker().closeForPane(params.id, "pane-gone");
      } catch (err) {
        logger.warn(`preview teardown after exit report for ${params.id} failed: ${String(err)}`);
      }
      return { ok: true } as const;
    },
    {
      body: ExitBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "reportSubshellExit",
        tags: ["subshells"],
        description: "Pane self-report: the harness exited, with its status when tmux could read one",
      },
    },
  );
