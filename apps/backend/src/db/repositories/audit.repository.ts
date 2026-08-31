import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { AuditEventsTable, NewAuditEvent } from "@/db/types/audit-events.db-types.js";

/**
 * Repository over the admin-visible audit trail (`audit_events` table,
 * migration 0004). One row per audited action (session lifecycle, admin user
 * management). Writes are fire-and-forget from the services; no read paths
 * exist yet outside the admin endpoint.
 */
export class AuditRepository extends BaseRepository {
  /**
   * Records an audit event.
   * @param event - Full event row (id/createdAt are caller-chosen so callers
   * can share timestamps with the action they log)
   */
  async create(event: NewAuditEvent): Promise<void> {
    await this.db.insertInto("auditEvents").values(event).execute();
  }

  /**
   * Lists the latest audit events, newest first.
   * @param limit - Maximum number of events to return (default 50 via the route)
   * @returns The events ordered by created_at descending (ties broken by id)
   */
  async listLatest(limit: number): Promise<AuditEventsTable[]> {
    return this.db
      .selectFrom("auditEvents")
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .selectAll()
      .execute();
  }
}
