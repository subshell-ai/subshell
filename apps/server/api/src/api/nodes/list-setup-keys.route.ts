import { Elysia, t } from "elysia";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { isCookieAdmin } from "@/modules/users/roles.js";
import { HttpError } from "@/shared/errors.js";

const SetupKeyRowSchema = t.Object({
  id: t.String({ description: "Setup key id" }),
  key: t.String({ description: "The setup key, usable until used or expired, inert after" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  expiresAt: t.String({ description: "ISO 8601 expiry timestamp" }),
  usedAt: t.Nullable(t.String({ description: "ISO 8601 redemption time, null while unused" })),
  targetNodeId: t.Union([t.String(), t.Null()]),
  consumedNodeId: t.Nullable(t.String({ description: "Node created by redeeming this key, null while unused" })),
  ownerUserId: t.Optional(
    t.String({
      description:
        "The key OWNER's user id, present only on the admin `all=1` listing. This is the future node owner: for a recovery key an ADMIN minted it is the node's owner, not the admin who triggered the mint",
    }),
  ),
  ownerLabel: t.Optional(
    t.String({
      description:
        "The key owner's display name, falling back to email, then to the raw user id for a deleted account, present only on the admin `all=1` listing",
    }),
  ),
});

const ListQuerySchema = t.Object({
  all: t.Optional(
    t.Literal("1", {
      description:
        "Admin-only: list EVERY setup key in the instance rather than the caller's own. Non-admins get 403; a machine token gets 403",
    }),
  ),
});

const ListResponseSchema = t.Object({
  keys: t.Array(SetupKeyRowSchema, {
    description: "Setup keys, newest first, each with its own key text",
  }),
});

/**
 * Maps a stored row to the listing shape.
 *
 * It is a projection, not a redaction: what it drops is `ownerUserId`, which the
 * caller already is, and it deliberately carries `key`. That is the whole point
 * of this route since the node-setup revamp (2026-09-17) — a minted key the
 * dialog closed without using was an open enrollment door the operator could
 * only close, not read, so the remedy was to revoke and re-mint. Scoping is
 * unchanged for the plain read: `listByUser(user.id)` answers for the caller's
 * own keys and nobody else's, and a used or expired row's key is inert on
 * sight. The admin `all=1` listing (audit 2026-09 item 4) re-adds
 * `ownerUserId` and a display label here rather than in a second mapper, so
 * the two answers cannot drift on what a row is.
 */
function toKeyRow(
  row: {
    id: string;
    key: string;
    createdAt: string;
    expiresAt: string;
    usedAt: string | null;
    consumedNodeId: string | null;
    targetNodeId: string | null;
  },
  owner?: { ownerUserId: string; ownerLabel: string },
) {
  return {
    id: row.id,
    key: row.key,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    consumedNodeId: row.consumedNodeId,
    targetNodeId: row.targetNodeId,
    ...(owner ? { ownerUserId: owner.ownerUserId, ownerLabel: owner.ownerLabel } : {}),
  };
}

/**
 * `GET /api/nodes/setup-keys` — setup keys, newest first (spec 2026-08-31
 * §9). Carries usage state (usedAt/consumedNodeId) and the key text, because
 * the Setup keys card is now the durable place a key is read from.
 * Browser sessions and explicitly enabled system keys may list their own keys.
 *
 * Two answers, one route. Without `all=1`: the caller's own keys, as always.
 * With `all=1` (audit 2026-09 item 4, operator-approved): every key in the
 * instance with its key owner's label — the admin's view of the enrollment
 * doors outstanding on their machine. That is a real widening (an admin reads
 * keys they did not mint, in the plaintext the plaintext-storage decision
 * already describes) and it is gated exactly like every other admin surface:
 * cookie-admin, machine token 403, plain
 * non-admin 403 rather than a silently-narrowed list (an ignored `all=1`
 * would tell a caller they were looking at everything when they were not).
 * The read is NOT audited, mirroring the owner-scoped read: nothing changes
 * state, and `docs/security.md` keeps reads off the trail.
 */
export const listSetupKeyRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .get(
    "/setup-keys",
    async ({ user, actor, query }) => {
      const keys = new NodeSetupKeysRepository(db);
      if (query.all === "1") {
        if (!(await isCookieAdmin(user, actor))) {
          throw new HttpError(403, "Only an admin can list every setup key on this instance.");
        }
        const rows = await keys.listAll();
        const labels = await new UsersRepository(db).displayNamesByIds([...new Set(rows.map((r) => r.ownerUserId))]);
        return {
          keys: rows.map((row) =>
            // A deleted key owner still owns rows that outlived the account;
            // the id is the honest label for one, not a blank.
            toKeyRow(row, { ownerUserId: row.ownerUserId, ownerLabel: labels.get(row.ownerUserId) ?? row.ownerUserId }),
          ),
        };
      }
      const rows = await keys.listByUser(user.id);
      // Recovery credentials can replace an existing machine's identity. Enrollment
      // automation must never acquire them through a supposedly ordinary list.
      return {
        keys: rows.filter((row) => actor === "cookie" || row.targetNodeId === null).map((row) => toKeyRow(row)),
      };
    },
    {
      query: ListQuerySchema,
      response: {
        200: ListResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      systemPermission: "nodes:enroll",
      detail: {
        operationId: "listNodeSetupKeys",
        tags: ["nodes"],
        description:
          "Lists node setup keys, each with its key text: the caller's own, or with all=1 every key in the instance with its key owner's label (cookie-admin only)",
      },
    },
  );
