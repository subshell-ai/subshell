import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { SshAgentIdentityViewSchema, throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { apiModels } from "@/schema/index.js";
import { listNodeAgentIdentities } from "@/services/ssh-launch.service.js";

export const sshIdentitiesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/identities",
    async ({ query, user, actor }) => {
      requireCookieActor(actor, "SSH identities are restricted to browser sessions");
      const result = await listNodeAgentIdentities({ viewerId: user.id, aNodeId: query.node });
      if (!result.ok) return throwCodedRefusal(result.refusal);
      return result.value;
    },
    {
      query: t.Object({ node: t.String({ minLength: 1 }) }),
      response: {
        200: t.Object({ identities: t.Array(SshAgentIdentityViewSchema) }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
    },
  );
