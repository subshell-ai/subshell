import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { throwCodedRefusal } from "@/api/ssh/ssh-views.js";
import { apiModels } from "@/schema/index.js";
import { sshListAliases } from "@/services/ssh-launch.service.js";

/**
 * `GET /api/ssh/aliases?node=<id>` — the NAMES of the machine's usable SSH
 * aliases (spec 2026-10-07 §5: discovery returns names, never config file
 * contents). Cookie-only; the gate (current launch access and readiness) and
 * the held-machine refusal run BEFORE the machine is asked anything, so a
 * machine the caller may not SSH through never sees a frame.
 *
 * A machine-level failure maps by kind: offline 409, an app too old for the
 * ssh commands 409 naming the update, no answer 409, the machine's own
 * `ok:false` 502 (its verbatim text is logged, never echoed).
 */
export const sshAliasesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/aliases",
    async ({ query, user, actor }) => {
      requireCookieActor(actor, "SSH alias discovery is restricted to browser sessions");
      const answer = await sshListAliases(user.id, query.node);
      if (!answer.ok) return throwCodedRefusal(answer.refusal);
      return answer.value;
    },
    {
      query: t.Object({
        node: t.String({
          minLength: 1,
          description: "Node id to read aliases from ('local' = the control-plane host)",
        }),
      }),
      response: {
        200: t.Object({
          aliases: t.Array(t.String({ description: "Alias name (sorted, deduplicated, concrete names only)" }), {
            description: "Usable alias NAMES, at most 500",
          }),
          includeCycle: t.Boolean({ description: "An include cycle was detected; the list is what parsed before it" }),
          truncated: t.Boolean({ description: "The alias cap was hit; more exist" }),
        }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshListAliases",
        tags: ["ssh"],
        description:
          "Lists the connecting machine's usable SSH alias names (its own config, parsed bounded). Owner-only and off by default; a machine whose SSH is not switched on refuses the command",
      },
    },
  );
