import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/**
 * Pane input over REST (spec 2026-09-25 MCP DX). `text` is typed verbatim,
 * the same dumb pipe the live attach socket flows keystrokes through; the
 * cap matches the create/restart prompt's, and a blank is refused by
 * `minLength` rather than silently typing nothing.
 */
const InputBodySchema = t.Object(
  {
    text: t.String({
      minLength: 1,
      maxLength: 20000,
      description: "Text to type into the pane, verbatim (escape sequences included; nothing is translated)",
    }),
    submit: t.Optional(
      t.Boolean({
        default: true,
        description:
          "Press Enter after the text so the pane acts on it (default true; false types into the prompt without submitting)",
      }),
    ),
  },
  {
    description:
      "Text typed into the running pane, optionally submitted. The route writes nothing itself: a gate, validation, or not-running refusal types nothing, and a success only means the bytes were sent.",
  },
);

const InputOkSchema = t.Object({
  ok: t.Literal(true, { description: "The input was accepted by the pane's machine" }),
});

/**
 * `POST /api/subshells/:id/input` types text into a RUNNING pane (the door the
 * MCP `send_to_subshell` tool rides). An `edit` act, like terminal input
 * on the live attach socket: a `view` grantee 403s, a foreign row 404s, and a
 * bearer pane key acts as its OWNER with boost and shares off (its own and its
 * owner's other subshells), the same per-subshell rule restart follows. A
 * non-running row is 409 SUBSHELL_NOT_RUNNING and an offline agent node 409
 * NODE_OFFLINE, both before anything is typed. `{ ok: true }` means the bytes
 * were accepted by the pane's machine, not that the pane acted on them.
 */
export const inputSubshellRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/input",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // `submit` arrives defaulted by the schema; the `?? true` is a plain
      // reading of the documented default, not a second rule.
      return await ctx.services.subshells.sendSubshellInput(user.id, params.id, body.text, body.submit ?? true, actor);
    },
    {
      body: InputBodySchema,
      response: {
        200: InputOkSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        // Foreign row (bearer or stranger), absent id: never a 403 on the way.
        404: "ApiErrorResponse",
        // 409 SUBSHELL_NOT_RUNNING (row not running) / NODE_OFFLINE (the
        // row's agent node has no live connection). Nothing was typed.
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sendSubshellInput",
        tags: ["subshells"],
        description:
          "Type text into a running pane, optionally submitted (an edit act; the pane's row is unchanged, so a refusal types nothing)",
      },
    },
  );
