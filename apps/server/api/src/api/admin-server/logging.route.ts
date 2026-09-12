import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { currentDebugLogging, setDebugLogging } from "@/services/logging-preference.js";
import { collectDeployment } from "@/services/server-deployment.js";

const LoggingBodySchema = t.Object({
  debug: t.Boolean({
    description: "Debug logging on: debug-level lines and every HTTP request go to the log file",
  }),
});

/**
 * `PUT /api/admin/server/logging` — the debug-logging switch (spec § 3.4).
 * Applied LIVE (the file transport's level) and persisted as an instance
 * setting, so it needs no restart; stdout is untouched either way.
 *
 * Refused while `SUBSHELL_DEBUG_LOGGING` forces it from the environment: a row
 * written there would be a success the next boot silently undoes, and the
 * message names the variable to change instead.
 */
export const loggingRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .put(
    "/logging",
    async ({ body, user, status }) => {
      const before = currentDebugLogging();
      if (before.source === "process env") {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.LOGGING_FROM_ENV,
            message:
              "SUBSHELL_DEBUG_LOGGING is set in the server's environment; unset it there to control debug logging from here",
          }),
        );
      }
      await setDebugLogging(body.debug);
      if (before.debug !== body.debug) {
        await audit({
          actorUserId: user.id,
          action: "server.logging.update",
          targetType: "server",
          targetId: "debug_logging",
          metadataJson: JSON.stringify({ from: before.debug, to: body.debug }),
        });
      }
      return collectDeployment();
    },
    {
      body: LoggingBodySchema,
      response: {
        200: DeploymentViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateServerLogging",
        tags: ["admin"],
        description:
          "Turn debug logging (and with it HTTP request logging) on or off, live and persisted. Cookie-admin only; 409 while the environment forces it.",
      },
    },
  );
