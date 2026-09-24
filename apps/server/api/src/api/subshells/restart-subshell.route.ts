import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { CreateSubshellResponseSchema } from "@/api/subshells/create-subshell.route.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/**
 * The optional preset swap riding a restart (spec 2026-09-23 §2). A MISSING
 * body is a plain restart exactly as before — that is what the SPA's Restart
 * item and the MCP `restart_subshell` tool send — so the object is mounted
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
  },
  { description: "Optional preset swap applied inside this restart; a refusal writes nothing." },
);

/**
 * `POST /api/subshells/:id/restart` — revives this subshell in place (same id):
 * new process, same row, conversation resumed when its transcript survived.
 * The optional `{ presetId }` body (null = presetless) swaps the row's preset
 * at the restart's swap point; every refusal leaves the preset untouched.
 */
export const restartSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/restart",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.restartSubshell(user.id, params.id, actor, body?.presetId);
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
        // NODE_OFFLINE); the parked row is rolled back before the 409.
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "restartSubshell",
        tags: ["subshells"],
        description:
          "Revive this subshell in place: same id and name, new process, conversation resumed when its transcript survived. An optional { presetId } body (string = a preset of yours sharing this subshell's harness, null = presetless) swaps the row's preset before the revive; a refusal of any kind writes nothing, and a body-less POST is the plain restart it has always been",
      },
    },
  );
