import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";

let auditRepo: AuditRepository | null = null;

function repo(): AuditRepository {
  auditRepo ??= new AuditRepository(db);
  return auditRepo;
}

/**
 * Records an audit event, best-effort: failures are logged via console.error
 * but never throw, so an audit problem can never break the action being
 * audited (which has usually already succeeded when this is called).
 *
 * Prefer the shorthand helpers for the common shapes.
 */
/** The shape of a single audit event (mirrors the audit_events table). */
export interface AuditEventInput {
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadataJson: string | null;
}

export async function audit(event: AuditEventInput): Promise<void> {
  try {
    await repo().create({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...event,
    });
  } catch (err) {
    console.error("audit: failed to record event", event.action, err);
  }
}
