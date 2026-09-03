import { Elysia, t } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { NodeViewSchema, toNodeViews } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { resolveNodeAccess } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET /api/nodes` — every node the caller can see: owned or shared, the
 * seeded `local` included via its Everyone grant (spec 2026-08-31 §2 — the
 * share row IS the visibility filter; a private foreign node is absent, so
 * ids cannot be probed from the list either).
 *
 * COOKIE-ONLY for phase 1: no machine token has a reason to enumerate nodes
 * yet, and mirroring the subshell rule (bearer actor, sharing/admin-boost off)
 * would be unused surface — bearer read deferred until a machine consumer
 * exists.
 */
export const listNodesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ user, actor }) => {
      requireCookieActor(
        actor,
        "Node listing is restricted to browser sessions (bearer read deferred until a machine consumer exists)",
      );
      // `findAccessible` returns owned/shared rows only, so the resolved access
      // is never "none" — the flatMap discard is a type witness, not behavior.
      const rows = await new NodesRepository(db).findAccessible(user.id);
      const isAdmin = (await new UserMetaRepository(db).getRole(user.id)) === "admin";
      const shares = await new NodeSharesRepository(db).listForNodes(rows.map((r) => r.id));
      const entries = rows.flatMap((row) => {
        const access = resolveNodeAccess(user.id, isAdmin, row, shares.get(row.id) ?? []);
        return access === "none" ? [] : [{ row, access, isAdmin }];
      });
      return { nodes: await toNodeViews(entries) };
    },
    {
      response: {
        200: t.Object({
          nodes: t.Array(NodeViewSchema, { description: "Every node visible to the caller (owner or grant)" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "listNodes",
        tags: ["nodes"],
        description: "List nodes visible to the caller — owned or shared (cookie-only in phase 1)",
      },
    },
  );
