import { audit } from "@/services/audit.js";

/**
 * The `ssh.*` audit family (SSH-SUPPORT.md §3's audit sentence, §10's rules):
 * actor/resource ids, connection revisions, grant/control changes,
 * destinations, and lifecycle outcomes - NEVER command text or output, which
 * §3 keeps out of operational logs by name. Destinations here means the
 * RESOURCE identity (connection id + revision + the snapshot's alias/host
 * pair, which the snapshot already displays in the SPA); the config contents
 * are not audited because they are never stored.
 *
 * Metadata rule per §10: ids and names only, and the same posture as the
 * transfer family - outcome rows for failures carry the fact, not the agent's
 * sentence (a refusal can name a path the auditor already has).
 */

/** One `ssh.*` audit row; `targetId` null when the act pre-dates any row (discovery/save). */
export function auditSsh(
  actorUserId: string,
  action: SshAuditAction,
  targetType: SshAuditTarget,
  targetId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  return audit({ actorUserId, action, targetType, targetId, metadataJson: JSON.stringify(metadata) });
}

/** The frozen event-name family (mirror of the §10 list added in docs/security.md). */
export type SshAuditAction =
  | "ssh.discover"
  | "ssh.resolve"
  | "ssh.test"
  | "ssh.connection.create"
  | "ssh.connection.update"
  | "ssh.connection.delete"
  | "ssh.grant"
  | "ssh.revoke"
  | "ssh.run.start"
  | "ssh.run.cancel"
  | "ssh.run.lifecycle"
  | "ssh.terminal.open"
  | "ssh.control.transition";

/** The audited resource kinds. */
export type SshAuditTarget = "ssh_connection" | "ssh_grant" | "ssh_run" | "ssh_pane" | "node";
