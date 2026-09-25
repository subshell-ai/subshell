import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/** One queue row: a person a door let through who is not a member yet (spec §6). */
const PendingUserSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "The email the door's profile carried" }),
  name: t.String({ description: "Display name; empty for a door arrival that carried none" }),
  providerId: t.Nullable(
    t.String({
      description: "The door this arrival came through; null for an account with no sign-in row (should not happen)",
    }),
  ),
  providerName: t.Nullable(
    t.String({
      description:
        "The door's current name, resolved live; null when the provider has since been removed, which the queue renders as a removed-provider label",
    }),
  ),
  arrivedAt: t.Nullable(
    t.String({ description: "ISO 8601 stamp of the last knock while pending; null once the row left pending" }),
  ),
  approvalState: t.Union([t.Literal("pending"), t.Literal("rejected")], {
    description: "Queue state. Approved accounts are members and live in GET /api/users, never here",
  }),
});

/** GET /api/users/pending response. */
const PendingResponseSchema = t.Object({
  pending: t.Array(PendingUserSchema, { description: "Pending and rejected rows, newest arrival first" }),
});

/**
 * `GET /api/users/pending` — the approval queue (admin only, cookie session).
 */
export const listPendingApprovalsRoute = new Elysia().use(requireAdmin).get(
  "/pending",
  async () => {
    // The queue list. Provider NAMES resolve live, from a read of the door
    // table, rather than by a JOIN that would vanish the row: a deleted
    // provider must render as "removed provider" (spec §6) — the queue is
    // the record of who knocked at a door this instance used to have.
    const rows = await new UsersRepository(db).listApprovalQueue();
    const names = new Map((await new AuthProvidersRepository(db).listAll()).map((row) => [row.id, row.name]));
    return {
      pending: rows.map((row) => ({
        ...row,
        providerName: row.providerId ? (names.get(row.providerId) ?? null) : null,
      })),
    };
  },
  {
    response: PendingResponseSchema,
    detail: {
      operationId: "listPendingApprovals",
      tags: ["users"],
      description:
        "The approval queue: pending and rejected arrivals, newest first (admin only, cookie session). Members never see it, and it never includes an approved account",
    },
  },
);
