import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { collectDeployment } from "@/services/server-deployment.js";
import { performRestart } from "@/services/server-restart.js";

const RestartBodySchema = t.Object({
  force: t.Optional(
    t.Boolean({
      description: "Restart even though the installed service definition would take live panes down",
    }),
  ),
});

const RestartResponseSchema = t.Object({
  restarting: t.Literal(true, { description: "The shutdown is scheduled; the manager respawns the process" }),
  resumeAt: t.String({
    description: "The saved APP_BASE_URL, where the server comes back, which may differ from where this request went",
  }),
});

/**
 * Test seams: the view and the act, replaceable without a module mock — a
 * route whose success path exits the process cannot be tested any other way.
 * @internal
 */
export const restartSeams = { deployment: collectDeployment, perform: performRestart };

/**
 * `POST /api/admin/server/restart` — the server restarts itself by EXITING,
 * and only when the service manager reports this very pid (spec § 3.3). The
 * unit is `Restart=always` and the plist `KeepAlive=true`, so an exit is a
 * restart there and nowhere else; started from a terminal or in a container
 * with no init it would just be a shutdown, which is the 409.
 *
 * The second refusal is pane safety, and it follows the CLI's: a definition
 * without `KillMode=process` / `AbandonProcessGroup` takes every live tmux
 * pane down with the process, so it needs `force` — the same bar
 * `service restart --force` sets.
 *
 * The 202 carries `resumeAt` because the restart may be the very thing that
 * changes the address: a caller who just saved a new port needs to be told
 * where the server comes back before its connection goes.
 */
export const restartRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/restart",
    async ({ body, user, status }) => {
      const view = restartSeams.deployment();
      if (!view.service.supervised) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.RESTART_UNAVAILABLE,
            message: view.restart.reason ?? "This server is not running under a service manager",
          }),
        );
      }
      if (view.service.paneSafety !== "keeps" && body.force !== true) {
        // The same wording rule the node routes carry: `unknown` is nobody
        // having read the definition, not a definition that kills, and the
        // refusal must not upgrade an unreadable unit into a promise about
        // panes dying. The CODE stays one value — this is WORDING only.
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.RESTART_KILLS_PANES,
            message:
              view.service.paneSafety === "kills"
                ? "The installed service definition would close every running subshell on restart; reinstall the service definition, or pass force to restart anyway"
                : "The installed service definition could not be read, so whether a restart keeps the running subshells is unknown; reinstall the definition, or pass force to restart anyway",
          }),
        );
      }
      await audit({
        actorUserId: user.id,
        action: "server.restart",
        targetType: "server",
        targetId: "process",
        metadataJson: JSON.stringify({ forced: body.force === true, resumeAt: view.settings.APP_BASE_URL.saved }),
      });
      restartSeams.perform();
      return status(202, { restarting: true as const, resumeAt: view.settings.APP_BASE_URL.saved });
    },
    {
      body: RestartBodySchema,
      response: {
        202: RestartResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "restartServer",
        tags: ["admin"],
        description:
          "Restart the server by exiting for its service manager to respawn (409 when not supervised, or when the definition would kill panes and force is not set). Cookie-admin only.",
      },
    },
  );
