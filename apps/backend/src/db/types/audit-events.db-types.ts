/**
 * Database table schema for the admin-visible audit trail.
 *
 * One row per audited action (session start/stop, user admin, config change).
 * Queries land in Task 10 (GET /api/audit).
 */
export interface AuditEventsTable {
  /** Unique event id (uuid) */
  id: string;
  /** Id of the user who performed the action (null for system events) */
  actorUserId: string | null;
  /** Action name, e.g. "session.delete" or "auth.sign_out" */
  action: string;
  /** Kind of the entity the action applies to, e.g. "session", "user" */
  targetType: string | null;
  /** Id of the specific target entity */
  targetId: string | null;
  /** JSON-encoded extra context (reason, before/after values, etc.) */
  metadataJson: string | null;
  /** ISO 8601 timestamp when the event was recorded */
  createdAt: string;
}

export type NewAuditEvent = AuditEventsTable;
