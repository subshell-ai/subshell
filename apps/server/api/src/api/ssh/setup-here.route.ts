import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";
import { setupHere } from "@/services/ssh-setup-here.service.js";
import { sshSetupTracker } from "@/services/ssh-setup-progress.js";

/**
 * `POST /api/ssh/setup-here` `{paneId}` - "Set up Subshell here" (spec
 * 2026-10-08 §7, Task 14): enroll the destination of an open SSH-terminal
 * pane as a node by running the ordinary install over a SEPARATE
 * non-interactive connection, leaving the pane itself untouched. The act is
 * owner-only by construction (a foreign pane is the service's 404), cookie-
 * only like every launcher door. Its answer identifies the enrolled node and
 * distinguishes enrollment from a confirmed connection. The minted setup key exists nowhere in
 * this response, its refusals, or the audit; the machine ran the install
 * where the key is allowed to live (spec §7's accepted postures) and the
 * plane kept only the parsed outcome.
 */
export const sshSetupHereRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/setup-here/:paneId",
    ({ user, actor, params }) => {
      requireCookieActor(actor, "SSH setup status is restricted to browser sessions");
      return { operation: sshSetupTracker.read(user.id, params.paneId) };
    },
    {
      params: t.Object({
        paneId: t.String({ minLength: 1, maxLength: 64, description: "Pane whose setup status to read" }),
      }),
      response: {
        200: t.Object({
          operation: t.Nullable(
            t.Object({
              stage: t.Union(
                [
                  t.Literal("checking"),
                  t.Literal("installing"),
                  t.Literal("connecting"),
                  t.Literal("enrolled"),
                  t.Literal("complete"),
                  t.Literal("failed"),
                ],
                { description: "Current server-observed setup stage" },
              ),
              startedAt: t.String({ description: "ISO timestamp when setup began" }),
              nodeId: t.Nullable(t.String({ description: "Enrolled node, which may still be offline" })),
              error: t.Nullable(t.String({ description: "Safe failure explanation, never installer output" })),
            }),
          ),
        }),
      },
      detail: {
        operationId: "sshSetupHereStatus",
        tags: ["ssh"],
        description:
          "Owner-scoped setup progress, retained for one hour after completion while this server process runs",
      },
    },
  )
  .post(
    "/setup-here",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "SSH setup acts are restricted to browser sessions");
      const answer = await sshSetupTracker.run(user.id, body.paneId, (onProgress) =>
        setupHere({ viewerId: user.id, paneId: body.paneId, onProgress }),
      );
      if (!answer.ok) {
        const r = answer.refusal;
        if (r.status === 422) {
          // Unreachable: no arm of this act carries a resolve outcome (the
          // destination was approved when the pane opened). An unreachable
          // arm is answered loudly, never swallowed - the connection's
          // posture restated.
          return throwCodedRefusal({
            status: 502,
            code: BackendErrorCodes.SSH_NODE_REFUSED,
            message: "The setup surface cannot answer that refusal shape.",
          });
        }
        return throwCodedRefusal(r);
      }
      return answer.value;
    },
    {
      body: t.Object({
        paneId: t.String({
          minLength: 1,
          maxLength: 64,
          description: "The open SSH-terminal pane whose destination is to become a node (owner-only)",
        }),
      }),
      response: {
        200: t.Object({
          nodeId: t.String({ description: "The newly enrolled node's id" }),
          connected: t.Optional(t.Boolean({ description: "False if enrolled but not confirmed connected" })),
        }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshSetupHere",
        tags: ["ssh"],
        description:
          "Runs the ordinary node enrollment install on an open SSH pane's destination over a separate non-interactive connection and answers the new node's id with its connection outcome; the pane keeps running and the enrollment key never appears in the pane, its log, or any returned text",
      },
    },
  );
