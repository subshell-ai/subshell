import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { setAutostart } from "@/service.js";
import { audit } from "@/services/audit.js";
import { collectDeployment, serviceDeps } from "@/services/server-deployment.js";

const AutostartBodySchema = t.Object({
  enabled: t.Boolean({ description: "Whether the installed service should start at login" }),
});

/**
 * Test seams: the view and the write, replaceable without a module mock.
 * @internal
 */
export const autostartSeams = { deployment: collectDeployment, apply: setAutostart, deps: serviceDeps };

/** Why this server's login behaviour cannot be changed from here, per case. */
const NO_SERVICE = "No service is installed on this machine, so there is nothing to start at login.";
const BY_APP =
  "This server runs with the Subshell Server app. To have it back at login, start the app at login instead.";
const UNKNOWN = "The service manager did not say whether this server starts at login.";

/**
 * `POST /api/admin/server/autostart` — whether the installed service comes
 * back at the next login (spec 2026-09-12 server-supervision § 3.4).
 *
 * **This is inside the "no route" rule rather than an exception to it.** Stop,
 * start, install, uninstall and reset have no route because each leaves the
 * server unreachable, so a page the server serves is the wrong place to drive
 * them. Arming or disarming login touches nothing about the running process —
 * `setAutostart` is `systemctl --user enable|disable` without `--now` on
 * Linux, and a file move on macOS — so the page asking for it cannot take
 * itself down.
 *
 * Three refusals, all 409, because each names a machine where the question
 * has no answer rather than a caller who may not ask it.
 */
export const autostartRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/autostart",
    async ({ body, user, status }) => {
      const view = autostartSeams.deployment();
      const refusal =
        view.service.manager === "app"
          ? BY_APP
          : !view.service.installed
            ? NO_SERVICE
            : view.service.enabled === null
              ? UNKNOWN
              : null;
      if (refusal !== null) {
        return status(409, apiErrorBody({ code: BackendErrorCodes.AUTOSTART_UNAVAILABLE, message: refusal }));
      }
      const from = view.service.enabled;
      // A no-op is not an act: `setAutostart` is idempotent, and auditing a
      // press that changed nothing would fill the trail with non-events.
      if (from === body.enabled) return collectDeployment();

      const result = autostartSeams.apply(autostartSeams.deps(), body.enabled);
      if (result.code !== 0) {
        // The manager's own words, verbatim — the same channel discipline the
        // CLI keeps. A sentence of ours here would be a second, worse
        // description of systemctl's or launchd's failure.
        return status(
          500,
          apiErrorBody({
            code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
            message: result.err.trim() || "The service manager did not say why it refused.",
          }),
        );
      }
      await audit({
        actorUserId: user.id,
        action: "server.autostart.update",
        targetType: "server",
        targetId: "service",
        metadataJson: JSON.stringify({ from, to: body.enabled }),
      });
      return collectDeployment();
    },
    {
      body: AutostartBodySchema,
      response: {
        200: DeploymentViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
        500: "ApiErrorResponse",
      },
      detail: {
        operationId: "setServerAutostart",
        tags: ["admin"],
        description:
          "Arm or disarm the installed service's start-at-login, without touching the running process (409 when nothing is installed, when the desktop app runs this server, or when the manager would not say). Cookie-admin only; answers the fresh deployment view.",
      },
    },
  );
