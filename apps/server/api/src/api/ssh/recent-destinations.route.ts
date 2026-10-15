import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshRecentDestinationViewSchema, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { apiModels } from "@/schema/index.js";
import { sshRecentDestinationsView, sshSetDefaultNode } from "@/services/ssh-launch.service.js";

/** Recent connections belong to their owner; preferences only choose a default node. */
export const sshRecentDestinationsRoutes = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/recent-destinations",
    async ({ user, actor }) => {
      requireCookieActor(actor, "SSH recent destinations are restricted to browser sessions");
      return await sshRecentDestinationsView(user.id);
    },
    {
      response: {
        200: t.Object({
          recent: t.Array(SshRecentDestinationViewSchema, {
            description: "Most recently connected destinations, newest first (max 20)",
          }),
          defaultNodeId: t.Nullable(
            t.String({ description: "Stored default connecting machine id; resolves to null when none was chosen" }),
            {
              description:
                "The caller's default connecting machine, or null. A node deleted since reads back as the stored id; the client decides",
            },
          ),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listSshRecentDestinations",
        tags: ["ssh"],
        description: "Lists the caller's recent SSH destinations and default connecting machine",
      },
    },
  )
  .patch(
    "/preferences",
    async ({ body, user, actor }) => {
      requireCookieActor(actor, "SSH preferences are restricted to browser sessions");
      const answer = await sshSetDefaultNode(user.id, body.defaultNodeId);
      if (!answer.ok) return throwCodedRefusal(answer.refusal); // the one arm it can carry is the write-time 404
      return { defaultNodeId: answer.value };
    },
    {
      body: t.Object({
        defaultNodeId: t.Nullable(
          t.String({ minLength: 1, description: "Node id to default the launcher's machine picker to" }),
          { description: "null clears the default" },
        ),
      }),
      response: {
        200: t.Object({
          defaultNodeId: t.Nullable(t.String({ description: "The stored default machine id (null = none)" })),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSshPreferences",
        tags: ["ssh"],
        description:
          "Sets (or clears) the caller's default connecting machine; the write validates the node is one the caller can see, a later deletion leaves the stored id readable",
      },
    },
  );
