import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { applyConfig } from "@/commands/configure.js";
import { configEnvAppliedKeys, resolveConfig, serverConfigDir } from "@/config-env.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { collectDeployment, type DeploymentSettingKey, settingSource } from "@/services/server-deployment.js";

const ConfigPatchSchema = t.Object(
  {
    port: t.Optional(t.Integer({ minimum: 1, maximum: 65535, description: "SERVER_PORT" })),
    host: t.Optional(t.String({ minLength: 1, description: "HOST (bind address)" })),
    baseUrl: t.Optional(t.String({ minLength: 1, description: "APP_BASE_URL" })),
    trustedOrigins: t.Optional(
      t.Array(t.String({ description: "One origin: scheme, host and optional port, nothing else" }), {
        description: "TRUSTED_ORIGINS; an empty array clears the key",
      }),
    ),
  },
  {
    description: "Fields to change; absent fields keep their stored value. DATABASE_PATH is CLI-only.",
  },
);

const ConfigPatchResponseSchema = t.Object({
  ...DeploymentViewSchema.properties,
  warnings: t.Array(t.String({ description: "One advisory sentence" }), {
    description:
      "The CLI's advisory warnings for the values written (a LAN bind with a loopback base URL; a base URL port that is not the bind port)",
  }),
});

/** Body field → the config.env key it writes, for the env-override refusal. */
const KEY_FOR_FIELD = {
  port: "SERVER_PORT",
  host: "HOST",
  baseUrl: "APP_BASE_URL",
  trustedOrigins: "TRUSTED_ORIGINS",
} as const satisfies Record<string, DeploymentSettingKey>;

/**
 * `PATCH /api/admin/server/config` — rewrite config.env through the CLI's OWN
 * writer (spec § 3.2). `applyConfig` is shared with `subshell-server
 * configure`, so the two cannot disagree about what a valid file is: the
 * component-wise origin validation and the canonical storage that
 * `docs/security.md` describes are true of this writer because it is that
 * writer.
 *
 * `DATABASE_PATH` is deliberately not settable here — moving the database from
 * a web page is a footgun with no undo, and `--db-path` remains.
 *
 * Two refusals, both before any write: 400 when a value fails validation
 * (carrying the CLI's own sentence), and 409 when the key's source is the
 * process environment — a file write would be masked at the next boot, so
 * reporting success would be reporting a change that never takes effect.
 *
 * Audits `server.config.update` with the changed keys. These are addresses,
 * not secrets: `BETTER_AUTH_SECRET` is not among the keys this route can
 * touch, and the test scans the audit metadata for it anyway.
 */
export const patchConfigRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .patch(
    "/config",
    async ({ body, user, status }) => {
      const fields = Object.keys(body) as (keyof typeof KEY_FOR_FIELD)[];
      if (fields.length === 0) {
        return status(400, apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Nothing to change" }));
      }
      const applied = configEnvAppliedKeys();
      // The file's own values are part of the question: under systemd every
      // key arrives through `EnvironmentFile=`, and a key the environment and
      // the file agree on is still the file's to change.
      const configValues = resolveConfig().values;
      for (const field of fields) {
        const key = KEY_FOR_FIELD[field];
        if (settingSource(key, process.env, applied, configValues) === "process env") {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.CONFIG_KEY_FROM_ENV,
              message: `${key} is set in the server's environment, so config.env cannot change it; change ${key} where the server is started`,
            }),
          );
        }
      }
      const result = applyConfig(
        {
          ...(body.port !== undefined ? { port: String(body.port) } : {}),
          ...(body.host !== undefined ? { host: body.host } : {}),
          ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
          ...(body.trustedOrigins !== undefined ? { trustedOrigins: body.trustedOrigins.join(",") } : {}),
        },
        serverConfigDir(),
      );
      if (!result.ok) {
        return status(
          400,
          apiErrorBody({ code: BackendErrorCodes.CONFIG_INVALID, message: `${result.key}: ${result.reason}` }),
        );
      }
      if (result.changed.length > 0) {
        await audit({
          actorUserId: user.id,
          action: "server.config.update",
          targetType: "server",
          targetId: "config.env",
          metadataJson: JSON.stringify({ changes: result.changed }),
        });
      }
      return { ...collectDeployment(), warnings: result.warnings };
    },
    {
      body: ConfigPatchSchema,
      response: {
        200: ConfigPatchResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "updateServerConfig",
        tags: ["admin"],
        description:
          "Rewrite config.env (port, bind address, public base URL, trusted origins) through the CLI's own validated writer; the change applies at the next restart. Cookie-admin only.",
      },
    },
  );
