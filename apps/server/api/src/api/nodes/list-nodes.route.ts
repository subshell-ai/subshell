import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { type NodeView, NodeViewSchema, toNodeViews } from "@/api/nodes/node-view.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { resolveNodeAccess } from "@/modules/nodes/access.js";
import { matchesListQuery } from "@/shared/list-filter.js";

const ListNodesQuerySchema = t.Object({
  q: t.Optional(t.String({ maxLength: LIST_SEARCH_MAX.nodes })),
  status: t.Optional(t.Union([t.Literal("online"), t.Literal("offline")])),
  access: t.Optional(t.Union([t.Literal("yours"), t.Literal("shared")])),
});

/**
 * `GET /api/nodes`: every node the caller can see, rendered through ONE
 * mapper so the two actor classes cannot disagree about the row shape.
 *
 * COOKIE actors (spec 2026-08-31 §2, where the share row IS the visibility
 * filter): a NON-admin sees owned or shared rows, the seeded `local` included
 * via its Everyone grant, and a private foreign node is absent, so ids cannot
 * be probed from the list. An ADMIN sees every machine node (`local` |
 * `agent`): the list answers the same visibility question the detail gate
 * already answers for admins (a foreign node is `edit`, never manageable —
 * no delete, no re-share, no maintenance flip), because Updates listed every
 * agent and running the whole instance includes seeing every machine
 * (docs/security.md §3).
 *
 * BEARER actors (any API key): the machine consumer this route's phase-1 note
 * deferred to arrived with the MCP DX work (spec 2026-09-25). A token holds
 * the node authority of the account it acts for (operator ruling 2026-11-10:
 * "if the user can already create a subshell on that node, they can via MCP
 * too"), so a bearer reads the same candidate set a NON-ADMIN browser gets —
 * `findAccessible`, owned plus shared, `local` included through its Everyone
 * grant — with no admin boost and no role read. The admin arm stays
 * browser-only: its rows carry capability flags a bearer's write routes would
 * refuse, and listing grants no configuration permission. The rows carry
 * `harnesses` and `canLaunch` honest for this actor class, which is the
 * payload the agent needs to pick a machine.
 */
export const listNodesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ query, user, actor }) => {
      const matches = (n: NodeView) =>
        matchesListQuery(query.q, n.name, n.hostname ?? n.id) &&
        (!query.status || n.status === query.status) &&
        (!query.access || (query.access === "yours" ? n.access === "owner" : n.access !== "owner"));
      if (actor === "cookie") {
        const isAdmin = (await new UserMetaRepository(db).getRole(user.id)) === "admin";
        // Admins read EVERY machine node (`local` | `agent`); everyone else
        // reads owned/shared rows. The admin arm makes the list answer the
        // same visibility question the detail gate already answers (an admin
        // `GET /api/nodes/:id` on a foreign node answers 200 with `edit`,
        // pinned in nodes-crud-route.test.ts) and the Updates page's
        // instance-wide Nodes list. Before it, a node owned by another
        // account was visible in two of the three surfaces and absent from
        // the one an operator actually navigates: you could not reach its
        // detail page to see WHY it was held or to press the remedy that IS
        // admin-capable (`update`, gated at `nodeCanConfigure`, which the
        // boosted `edit` passes) — while shares and maintenance stayed
        // owner-only all along, boost included (measured on the disaresta
        // plane, 2026-10-09: a held node named "AI PC", listed by Updates,
        // invisible on Nodes).
        // For a NON-admin, `findAccessible` returns owned/shared rows only,
        // so the resolved access is never "none"; the flatMap discard is a
        // type witness, not behavior. For an admin, foreign private rows
        // resolve to the boosted `edit` exactly as on the detail path.
        const nodes = new NodesRepository(db);
        const rows = isAdmin ? await nodes.findAllMachines() : await nodes.findAccessible(user.id);
        const shares = await new NodeSharesRepository(db).listForNodes(rows.map((r) => r.id));
        const entries = rows.flatMap((row) => {
          const rowShares = shares.get(row.id) ?? [];
          const access = resolveNodeAccess(user.id, isAdmin, row, rowShares);
          // The unboosted reading rides along: `canLaunch` reads it for the
          // control-plane host, where an admin's instance-wide `edit` must not
          // stand in for a launch grant that was removed.
          const granted = resolveNodeAccess(user.id, false, row, rowShares);
          return access === "none" ? [] : [{ row, access, isAdmin, granted, exposeUpdate: true }];
        });
        return {
          nodes: (await toNodeViews(entries)).filter(matches),
        };
      }
      // Bearer: the candidate set a NON-ADMIN browser gets — owned plus shared
      // rows, no role read, no admin boost. A token acts as its account
      // (operator ruling 2026-11-10), so a machine shared with that account is
      // a launch target and belongs here; `local` rides its Everyone grant,
      // exactly as it does on the human's Nodes page. Rows render with
      // `isAdmin: false`, so every capability flag is the NON-BOOSTED reading:
      // on the account's own rows that legitimately still shows
      // `canManage`/`canRetire` (the same flags a non-admin browser sees),
      // while listing itself grants no configuration permission and this
      // bearer's write routes stay refused.
      const rows = await new NodesRepository(db).findAccessible(user.id);
      const shares = await new NodeSharesRepository(db).listForNodes(rows.map((r) => r.id));
      const entries = rows.flatMap((row) => {
        const access = resolveNodeAccess(user.id, false, row, shares.get(row.id) ?? []);
        return access === "none" ? [] : [{ row, access, isAdmin: false, granted: access, exposeUpdate: false }];
      });
      return {
        nodes: (await toNodeViews(entries)).filter(matches),
      };
    },
    {
      query: ListNodesQuerySchema,
      response: {
        200: t.Object({
          nodes: t.Array(NodeViewSchema, {
            description:
              "Every node visible to the caller (cookie: owned, granted, or — for an admin — every machine node, `local` or `agent`, as on the detail route; bearer: the non-admin view — owned plus shared machines, `local` included through its Everyone grant)",
          }),
        }),
        401: "ApiErrorResponse",
      },
      systemPermission: "nodes:read",
      detail: {
        operationId: "listNodes",
        tags: ["nodes"],
        description:
          "List nodes visible to the caller: a cookie sees owned or shared rows (an admin sees every machine node, `local` or `agent`, matching the detail gate's boost); a machine token sees what a non-admin browser sees — owned plus shared machines, the control-plane host included through its Everyone grant (disclosure-only)",
      },
    },
  );
