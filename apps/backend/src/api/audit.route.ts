import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";

const AuditEventSchema = t.Object({
  id: t.String({ description: "Event id" }),
  actorUserId: t.Union([t.String(), t.Null()], {
    description: "User who performed the action (null for system events)",
  }),
  action: t.String({ description: 'Action name, e.g. "session.delete"' }),
  targetType: t.Union([t.String(), t.Null()], { description: "Kind of the target entity, e.g. session/user" }),
  targetId: t.Union([t.String(), t.Null()], { description: "Id of the target entity" }),
  metadata: t.Unknown({ description: "Decoded JSON metadata attached to the event" }),
  createdAt: t.String({ description: "ISO 8601 timestamp of the event" }),
});

/**
 * Admin audit trail endpoint. The table is written by the session lifecycle
 * paths (session.create/restart/terminate/delete) and admin user creation;
 * auth sign-in/out recording is deferred (see session-manager notes).
 */
export const auditRoutes = new Elysia({ prefix: "/api/audit" }).use(requireAdmin).get(
  "/",
  async ({ query }) => {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const rows = await new AuditRepository(db).listLatest(limit);
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
    }),
    response: t.Array(AuditEventSchema, { description: "Latest audit events, newest first" }),
    detail: {
      operationId: "listAuditEvents",
      tags: ["audit"],
      description: "Lists the latest audit events (admin only)",
    },
  },
);
