import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { AuditEventsTable, NewAuditEvent } from "@/db/types/audit-events.db-types.js";

/**
 * Repository over the admin-visible audit trail (`audit_events` table,
 * migration 0004). One row per audited action (subshell lifecycle, admin user
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

  /**
   * One KEYSET page of the trail — the `limit` rows strictly older than the
   * cursor, newest first. Same order as {@link listLatest}, which is what
   * makes `(createdAt, id)` a valid cursor: the trail is append-only and the
   * ordering is total (id breaks timestamp ties), so a page cannot grow
   * duplicates or skip rows the way OFFSET paging would while events land.
   *
   * @param limit - Max rows for the page
   * @param before - The oldest row of the NEWER page (`createdAt` + `id`), or
   *                 nothing for the first page (then this is `listLatest`)
   */
  async listPage(limit: number, before?: { createdAt: string; id: string }): Promise<AuditEventsTable[]> {
    let query = this.db
      .selectFrom("auditEvents")
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .selectAll();
    if (before) {
      // Row-comparison "older than", spelled for a total order: strictly
      // earlier timestamp, or the same timestamp with a lexicographically
      // smaller id — exactly what the ORDER BY puts on the next page.
      query = query.where((eb) =>
        eb.or([
          eb("createdAt", "<", before.createdAt),
          eb.and([eb("createdAt", "=", before.createdAt), eb("id", "<", before.id)]),
        ]),
      );
    }
    return query.execute();
  }
}
