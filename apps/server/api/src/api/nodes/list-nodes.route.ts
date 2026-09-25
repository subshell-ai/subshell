import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { NodeViewSchema, toNodeViews } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { resolveNodeAccess } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET /api/nodes`: every node the caller can see, rendered through ONE
 * mapper so the two actor classes cannot disagree about the row shape.
 *
 * COOKIE actors (spec 2026-08-31 §2, where the share row IS the visibility
 * filter): owned or shared, the seeded `local` included via its Everyone
 * grant; a private foreign node is absent, so ids cannot be probed from the
 * list either.
 *
 * BEARER actors (any API key): the machine consumer this route's phase-1 note
 * deferred to arrived with the MCP DX work (spec 2026-09-25). A pane picking
 * a launch target needs exactly the candidate set `resolveLaunchNode` step 3
 * resolves for a machine actor: `NodesRepository.listByOwner`, STRICT
 * owner-only, no admin boost and no shares (what the human can see through a
 * grant buys their machine nothing; `local` belongs to the system user, so a
 * human owner's token never sees it). The rows carry `harnesses` and
 * `canLaunch` honest for this actor class, which is the payload the agent
 * needs to pick a machine. DISCLOSURE-ONLY, like the pinned subshell-list
 * rule it mirrors: node WRITES and the detail route `GET /api/nodes/:id`
 * stay cookie-only.
 */
export const listNodesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ user, actor }) => {
      if (actor === "cookie") {
        // `findAccessible` returns owned/shared rows only, so the resolved
        // access is never "none"; the flatMap discard is a type witness, not
        // behavior.
        const rows = await new NodesRepository(db).findAccessible(user.id);
        const isAdmin = (await new UserMetaRepository(db).getRole(user.id)) === "admin";
        const shares = await new NodeSharesRepository(db).listForNodes(rows.map((r) => r.id));
        const entries = rows.flatMap((row) => {
          const rowShares = shares.get(row.id) ?? [];
          const access = resolveNodeAccess(user.id, isAdmin, row, rowShares);
          // The unboosted reading rides along: `canLaunch` reads it for the
          // control-plane host, where an admin's instance-wide `edit` must not
          // stand in for a launch grant that was removed.
          const granted = resolveNodeAccess(user.id, false, row, rowShares);
          return access === "none" ? [] : [{ row, access, isAdmin, granted }];
        });
        return { nodes: await toNodeViews(entries) };
      }
      // Bearer: the strict owner-only set, the same candidate source
      // `resolveLaunchNode` step 3 uses for machine actors. No role read and
      // no share lookup happen at all: the machine path stays as strict as a
      // plain owner check, and an owned row resolves to `owner` under both
      // readings (the flatMap discard is the same type witness as above).
      const rows = await new NodesRepository(db).listByOwner(user.id);
      const entries = rows.flatMap((row) => {
        const access = resolveNodeAccess(user.id, false, row, []);
        return access === "none" ? [] : [{ row, access, isAdmin: false, granted: access }];
      });
      return { nodes: await toNodeViews(entries) };
    },
    {
      response: {
        200: t.Object({
          nodes: t.Array(NodeViewSchema, {
            description: "Every node visible to the caller (cookie: owner or grant; bearer: owned only)",
          }),
        }),
        401: "ApiErrorResponse",
      },
      detail: {
        operationId: "listNodes",
        tags: ["nodes"],
        description:
          "List nodes visible to the caller: cookie sees owned or shared, a machine token sees only its owner's own nodes (disclosure-only)",
      },
    },
  );
