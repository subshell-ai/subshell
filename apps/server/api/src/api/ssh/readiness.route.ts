import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiModels } from "@/schema/index.js";
import { sshReadiness } from "@/services/ssh-policy.service.js";

export const sshReadinessRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/readiness",
    async ({ user, actor }) => {
      requireCookieActor(actor, "SSH readiness is restricted to browser sessions");
      const rows = await new NodesRepository(db).findAccessible(user.id);
      const machines: ({ node: Awaited<ReturnType<typeof toNodeView>> } & Awaited<ReturnType<typeof sshReadiness>>)[] =
        [];
      for (const row of rows) {
        const gate = await loadNodeGate(user.id, row.id);
        if (!gate) continue;
        machines.push({
          node: await toNodeView(row, gate.access, gate.isAdmin, gate.granted),
          ...(await sshReadiness(gate)),
        });
      }
      return { machines };
    },
    {
      response: {
        200: t.Object({
          machines: t.Array(
            t.Object({
              node: NodeViewSchema,
              canConnect: t.Boolean(),
              canConfigure: t.Boolean(),
              blockers: t.Array(t.Object({ code: t.String(), message: t.String() })),
            }),
          ),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
    },
  );
