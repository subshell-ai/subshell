import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";

const AuditEventSchema = t.Object({
  id: t.String({ description: "Event id" }),
  actorUserId: t.Union([t.String(), t.Null()], {
    description: "User who performed the action (null for system events)",
  }),
  action: t.String({ description: 'Action name, e.g. "subshell.delete"' }),
  targetType: t.Union([t.String(), t.Null()], { description: "Kind of the target entity, e.g. subshell/user" }),
  targetId: t.Union([t.String(), t.Null()], { description: "Id of the target entity" }),
  metadata: t.Unknown({ description: "Decoded JSON metadata attached to the event" }),
  createdAt: t.String({ description: "ISO 8601 timestamp of the event" }),
});

/**
 * Admin audit trail endpoint. The table is written by the subshell lifecycle
 * paths (subshell.create/restart/terminate/delete) and admin user creation;
 * auth sign-in/out recording is deferred (see subshell-manager notes).
 */
export const auditRoutes = new Elysia({ prefix: "/api/audit" })
  .use(requireAdmin)
  .use(apiModels)
  .get(
    "/",
    async ({ query, status }) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
      // The cursor is a PAIR or nothing: one half alone cannot locate a row in
      // the (createdAt, id) order, and silently reading it as "first page"
      // would show the operator page 1 twice and call it page 3.
      if ((query.beforeCreatedAt === undefined) !== (query.beforeId === undefined)) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: "beforeCreatedAt and beforeId must be supplied together",
          }),
        );
      }
      const rows = await new AuditRepository(db).listPage(
        limit,
        query.beforeCreatedAt !== undefined && query.beforeId !== undefined
          ? { createdAt: query.beforeCreatedAt, id: query.beforeId }
          : undefined,
      );
      return rows.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadataJson ? (JSON.parse(row.metadataJson) as unknown) : null,
        createdAt: row.createdAt,
      }));
    },
    {
      query: t.Object({
        limit: t.Optional(
          t.Number({ default: 50, minimum: 1, maximum: 500, description: "Maximum number of events to return" }),
        ),
        beforeCreatedAt: t.Optional(
          t.String({
            description: "Keyset cursor: the `createdAt` of the oldest row on the newer page. Requires beforeId.",
          }),
        ),
        beforeId: t.Optional(
          t.String({
            description: "Keyset cursor: the `id` of the oldest row on the newer page. Requires beforeCreatedAt.",
          }),
        ),
      }),
      response: {
        200: t.Array(AuditEventSchema, { description: "One page of audit events, newest first" }),
        400: "ApiErrorResponse",
      },
      detail: {
        operationId: "listAuditEvents",
        tags: ["audit"],
        description: "Lists the latest audit events (admin only)",
      },
    },
  );
