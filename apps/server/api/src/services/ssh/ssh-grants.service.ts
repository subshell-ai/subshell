import { randomUUID } from "node:crypto";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { SshGrantTable } from "@/db/types/ssh-grants.db-types.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type {
  SshGrantListView,
  SshGrantRequest,
  SshGrantView,
  SshRevokeGrantView,
} from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { bestEffortRunCancel, nodeSshInputControl, SshNodeRefusal } from "@/services/ssh/ssh-node-client.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { refuseSshDecision } from "@/services/ssh/ssh-refusal.js";
import { applyRunFacts, sshRunsRepo } from "@/services/ssh/ssh-runs.service.js";

/**
 * The grants domain (SSH-SUPPORT.md §2): a grant binds one connection
 * REVISION to one pane and its CURRENT credential, issued by the owning
 * human, revocable by that human, and never inherited by children or
 * restarted panes.
 *
 * Revocation is the spec's full sentence, not just the stamp: history stays
 * (the row flips to revoked), NEW dispatch stops (the granted gate re-asks
 * the active row on every use), runs and terminals initiated UNDER THAT
 * GRANT are cancelled where reachable (human sessions and other grants' work
 * are untouched - §2 says so by name), queued input is fenced by raising the
 * pane's control generation (the node enforces the fence below the new
 * number), and live stream closure lands with workstream C's subscription
 * seam (named in the task-D report; the generation raise is the durable half
 * that works without it).
 */

const grants = new SshGrantsRepository(db);
const connections = new SshConnectionsRepository(db);
const runs = sshRunsRepo();
const panes = new SshPanesRepository(db);
const subshells = new SubshellsRepository(db);

/** `GET …/connections/:id/grants`: the owner's view - active rows and revoked history. */
export async function sshListGrants(caller: SshCaller, connectionId: string): Promise<SshGrantListView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "grant", connectionId });
  if (!gate.allow) refuseSshDecision(gate);
  const rows = await grants.listByConnection(connectionId);
  return { grants: rows.map(toGrantView) };
}

/**
 * `POST …/connections/:id/grants`: grant the CURRENT revision to one RUNNING
 * pane of the caller's own. The key identity is read from the pane's row
 * (never the request body), which is what binds the grant to the current
 * credential; a pane with no issued key (an SSH terminal pane, a pre-token
 * row) cannot be granted, and §2's "must be running" refuses the rest.
 */
export async function sshGrant(caller: SshCaller, connectionId: string, body: SshGrantRequest): Promise<SshGrantView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "grant", connectionId });
  if (!gate.allow) refuseSshDecision(gate);
  const conn = await connections.findById(connectionId);
  if (!conn || conn.userId !== caller.userId) refuseSshDecision({ allow: false, code: "not_found" });

  const pane = await subshells.findById(body.subshellId);
  if (!pane || pane.userId !== caller.userId) refuseSshDecision({ allow: false, code: "not_found" });
  if (pane.status !== "running" || pane.alive !== 1) {
    throwApiError({
      code: BackendErrorCodes.SUBSHELL_NOT_RUNNING,
      message: "Only a running pane can be granted a connection (spec 2026-10-04 §2)",
      doNotLog: true,
    });
  }
  if (pane.apiKeyId === null) {
    throwApiError({
      code: BackendErrorCodes.BAD_REQUEST,
      message: "This pane has no issued credential to bind a grant to",
      doNotLog: true,
    });
  }

  const existing = await grants.findActive(conn.id, pane.id, pane.apiKeyId);
  if (existing) return toGrantView(existing);
  const row = await grants.create({
    id: randomUUID(),
    connectionId: conn.id,
    connectionRevision: conn.revision,
    subshellId: pane.id,
    apiKeyId: pane.apiKeyId,
    grantedByUserId: caller.userId,
    revokedAt: null,
  });
  await auditSsh(caller.userId, "ssh.grant", "ssh_grant", row.id, {
    connectionId: conn.id,
    connectionRevision: conn.revision,
    subshellId: pane.id,
  });
  return toGrantView(row);
}

/**
 * `DELETE …/connections/:id/grants/:subshellId`: revoke every ACTIVE grant
 * for the pair, then run the orchestration (§2's revocation sentence). The
 * generation raise fences queued input AT THE NODE even when the node is
 * offline - the plane's row is already raised and the transition is
 * re-dispatched by the reconnect pass's cancel sweep; stream closure is
 * workstream C's seam (report integration request).
 */
export async function sshRevoke(
  caller: SshCaller,
  connectionId: string,
  subshellId: string,
): Promise<SshRevokeGrantView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "revoke", connectionId });
  if (!gate.allow) refuseSshDecision(gate);
  const conn = await connections.findById(connectionId);
  if (!conn || conn.userId !== caller.userId) refuseSshDecision({ allow: false, code: "not_found" });

  const revokedIds = await grants.revokeActiveForPair(conn.id, subshellId);
  if (revokedIds.length === 0) return { revoked: false };

  // Cancel the runs initiated under EACH revoked grant, and only those
  // (§2: never a human's, never another grant's). Offline dispatch stays
  // pending: markCancelRequested is the durable fact, and the reconnect pass
  // dispatches before new work.
  for (const grantId of revokedIds) {
    const grantRow = await grants.findById(grantId);
    if (!grantRow) continue;
    for (const run of await runs.listActiveForGrant(grantId, grantRow.apiKeyId)) {
      await runs.markCancelRequested(run.id);
      if (run.nodeId !== null && getLive(run.nodeId)) {
        const facts = await bestEffortRunCancel(run.nodeId, run.id);
        if (facts) await applyRunFacts(run.id, facts);
      }
      await auditSsh(caller.userId, "ssh.run.cancel", "ssh_run", run.id, { reason: "grant_revoked" });
    }
    // Terminals opened under this grant: fence their queued input by raising
    // the generation (mode unchanged), and cancel where the pane is still
    // live. Full termination of a managed pane runs C's lifecycle seam -
    // report item; the generation raise already makes stale input refuse.
    for (const pane of await panes.listByConnection(conn.id)) {
      if (pane.grantId !== grantId) continue;
      const raised = await panes.setControl(pane.subshellId, pane.controlOwner);
      if (!raised) continue;
      const paneRow = await subshells.findById(pane.subshellId);
      if (!paneRow || paneRow.nodeId === null) continue;
      if (getLive(paneRow.nodeId)) {
        try {
          await nodeSshInputControl(paneRow.nodeId, {
            subshellId: pane.subshellId,
            mode: raised.controlOwner,
            generation: raised.controlGeneration,
          });
        } catch (err) {
          if (!(err instanceof SshNodeRefusal)) throw err;
        }
      }
    }
    await auditSsh(caller.userId, "ssh.revoke", "ssh_grant", grantId, {
      connectionId: conn.id,
      subshellId,
    });
  }
  return { revoked: true };
}

/** Project a grant row onto the frozen view. */
export function toGrantView(row: SshGrantTable): SshGrantView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionRevision: row.connectionRevision,
    subshellId: row.subshellId,
    apiKeyId: row.apiKeyId,
    grantedByUserId: row.grantedByUserId,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    active: row.revokedAt === null,
  };
}
