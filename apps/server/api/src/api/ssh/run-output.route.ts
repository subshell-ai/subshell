import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshRunViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshRunRead } from "@/services/ssh/ssh-runs.service.js";

/**
 * `GET /api/ssh/runs/:id/output` (spec §3): the bounded incremental RELAY of
 * the node-retained output - the server stores run METADATA and never a
 * second copy, so this endpoint moves bytes it does not keep. The window is
 * capped at the frozen 256 KiB across both streams (clamp, not refuse), the
 * long poll at 30 s, and the two honesty rules the spec names: closing this
 * read or timing out a wait cancels NOTHING, and an offset past retained
 * output answers `cursorExpired` so the caller restarts from 0 rather than
 * silently reusing a dead cursor.
 */

const OutputQuerySchema = t.Object({
  stdoutFromByte: t.Optional(t.Numeric({ description: "stdout byte offset to read from (default 0)" })),
  stderrFromByte: t.Optional(t.Numeric({ description: "stderr byte offset to read from (default 0)" })),
  maxBytes: t.Optional(
    t.Numeric({ description: "Combined cap across both streams (default and max 256 KiB; clamped, not refused)" }),
  ),
  waitMs: t.Optional(
    t.Numeric({ description: "Long-poll budget ms (default 0, max 30 000); a wait is neither an error nor a cancel" }),
  ),
});

const RunOutputViewSchema = t.Object({
  run: SshRunViewSchema,
  stdout: t.String({ description: "Decoded stdout bytes for this window (UTF-8 lossy; rendered as data, never HTML)" }),
  stderr: t.String({ description: "Decoded stderr bytes for this window" }),
  stdoutNext: t.Number({ description: "stdout offset to pass next" }),
  stderrNext: t.Number({ description: "stderr offset to pass next" }),
  stdoutTotal: t.Number({ description: "stdout bytes retained in total" }),
  stderrTotal: t.Number({ description: "stderr bytes retained in total" }),
  truncated: t.Boolean({ description: "Retention drain dropped bytes; this window is not the whole transcript" }),
  cursorExpired: t.Boolean({ description: "A requested offset points past retained output; restart from 0" }),
});

export const sshRunOutputRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/runs/:id/output",
    async ({ params, query, user, actor, principal, apiKeyId, apiKeyPermissions }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "read");
      return await sshRunRead(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id, query);
    },
    {
      params: t.Object({ id: t.String({ description: "Run id (opaque, server-allocated)" }) }),
      query: OutputQuerySchema,
      response: {
        200: RunOutputViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshReadRunOutput",
        tags: ["ssh"],
        description:
          "Bounded incremental output relay of the node-retained bytes plus fresh facts; closing this read or a timed-out wait cancels nothing (an expired cursor says so instead of reusing)",
      },
    },
  );
