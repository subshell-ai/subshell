import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { CreateSubshellResponseSchema } from "@/api/subshells/create-subshell.route.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/**
 * The optional preset swap riding a restart (spec 2026-09-23 §2), and since
 * spec 2026-09-25 the optional prompt. A MISSING body is a plain restart
 * exactly as before (that is what the SPA's Restart item and the MCP
 * `restart_subshell` tool's current calls send), so the object is mounted
 * `t.Optional`: a bare `t.Object` here (even with every property optional)
 * refuses a body-less POST as a validation failure.
 */
const RestartBodySchema = t.Object(
  {
    presetId: t.Optional(
      t.Nullable(
        t.String({
          description:
            "Swap the row's preset to this id (or null for presetless) before reviving: it must be a preset owned by the caller and share the subshell's harness. Absent = a plain restart with the preset it has.",
        }),
      ),
    ),
    prompt: t.Optional(
      t.String({
        maxLength: 20000,
        description:
          "Task text typed into the revived pane once it shows output, and submitted, after a SUCCESSFUL revive (the create flow's settle loop; a blank asks for nothing). The response's promptDelivered says whether it was typed.",
      }),
    ),
  },
  {
    description:
      "Optional preset swap and/or task prompt riding this restart. A refusal at the gate, in validation, at maintenance, by the offline pre-gate or because a restart is already running writes nothing and types nothing; a revive that fails after the swap leaves the row dead keeping the chosen preset.",
  },
);

/**
 * `POST /api/subshells/:id/restart` — revives this subshell in place (same id):
 * new process, same row, conversation resumed when its transcript survived.
 * The optional `{ presetId }` body (null = presetless) swaps the row's preset
 * at the restart's swap point, and the optional `{ prompt }` (spec 2026-09-25)
 * is typed into the revived pane once it settles, `promptDelivered` reporting
 * whether it was. A refusal at the gate, in validation, at maintenance, by the
 * offline pre-gate, or with 409 RESTART_IN_FLIGHT when the id's in-flight lease
 * is already held, writes nothing and types nothing; a revive that fails after
 * the swap leaves the row dead keeping the chosen preset (spec §4). The MCP
 * `restart_subshell` tool still sends a bare body today; both fields exist for
 * the callers that grow one.
 */
export const restartSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/restart",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.restartSubshell(user.id, params.id, actor, body?.presetId, body?.prompt);
    },
    {
      body: t.Optional(RestartBodySchema),
      response: {
        200: CreateSubshellResponseSchema,
        401: "ApiErrorResponse",
        // 400 INVALID_PRESET: the swap preset is unknown, not the caller's,
        // or from another harness (spec 2026-09-23 §2). Nothing was written.
        400: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        // Spec §5.6: the row's agent node has no live connection (409
        // NODE_OFFLINE) — refused here before the manager when the restart
        // carries a swap; otherwise the kill fails and the parked row is
        // rolled back before the 409.
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "restartSubshell",
        tags: ["subshells"],
        description:
          "Revive this subshell in place: same id and name, new process, conversation resumed when its transcript survived. An optional { presetId } body (string = a preset of yours sharing this subshell's harness, null = presetless) swaps the row's preset before the revive, and an optional { prompt } is typed into the revived pane once it settles (promptDelivered reports whether); a refusal at the gate, in validation, at maintenance, by the offline pre-gate or because a restart is already running writes nothing and types nothing (a revive that fails after the swap leaves the row dead keeping it), and a body-less POST is the plain restart it has always been",
      },
    },
  );
