import { randomUUID } from "node:crypto";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { SshGrantTable } from "@/db/types/ssh-grants.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
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
import { applyRunFacts, sshRunsRepo } from "@/services/ssh/ssh-run-mirror.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { logger } from "@/utils/logger.js";
import { closeViewersForSubshell } from "@/ws/viewers.js";

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
 * number), every live terminal stream on an affected pane is CLOSED
 * ({@link closeViewersForSubshell} - a socket authenticates once and is
 * never re-checked, so closing it is the ONLY thing that stops it streaming),
 * and a live managed terminal is TERMINATED where reachable (see
 * {@link revokeTerminateManaged} for the offline half).
 */

const grants = new SshGrantsRepository(db);
const connections = new SshConnectionsRepository(db);
const runs = sshRunsRepo();
const panes = new SshPanesRepository(db);
const subshells = new SubshellsRepository(db);
/**
 * A manager built from the module's `db` - the lifecycle act (terminate) is
 * the ORDINARY pane teardown, the same requestless-graph construction
 * `maintenance.ts` and `lockdown.ts` use; `restartInFlight` is module-global,
 * so any instance is safe.
 */
const paneManager = new SubshellManagerService({
  subshells,
  presets: new PresetsRepository(db),
});

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
 * re-dispatched by the reconnect pass's cancel sweep; live streams close
 * through C's {@link closeViewersForSubshell}; and every managed terminal
 * opened under a revoked grant is terminated (reachable now, or retired with
 * the reconnect census as the pending kill - see {@link revokeTerminateManaged}).
 * The ordering is deliberate and it is a race contract, not style: raise the
 * generation FIRST (the durable fence that holds whatever else fails), then
 * close the streams IMMEDIATELY after the raise commits and before ANY
 * further await, then terminate last (it needs the row facts). The middle
 * step has to hug the commit because the stamped input writers (REST and
 * WS) read the PLANE's generation per write and the node accepts anything
 * AT the mirror ("equal-or-higher", `input-generation.ts`): every await
 * between the commit and the close is a window in which a revoked pane's
 * already-open socket keeps typing at the raised number. A frame stamped
 * BELOW the raise (read before the commit) is refused node-side - the arm
 * the races suite pins - so what this ordering shrinks is the
 * climb-the-fence window, from an RPC round trip (re-review round 1) to a
 * microtask (now).
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
    // Terminals opened under THIS grant (and only theirs): raise the
    // generation first - the durable fence that holds even while the node is
    // offline - then close every live stream on the pane, then terminate the
    // pane where reachable (§2's full sentence; §6's "active streams" race).
    for (const pane of await panes.listByConnection(conn.id)) {
      if (pane.grantId !== grantId) continue;
      const raised = await panes.setControl(pane.subshellId, pane.controlOwner);
      if (!raised) continue;
      // Stream closure on the SAME beat the raise commits - before any
      // further await, and before the row re-read and the node RPC below
      // (re-review round 1). An attach socket authenticates once and is
      // never re-checked; while one is open it can read the RAISED plane
      // generation and be ACCEPTED by the node's equal-or-higher rule, so
      // the close must not trail the `ssh_input_control` round trip. The
      // reconnect passes the attach-redeem gate fresh, and the gate refuses.
      closeViewersForSubshell(pane.subshellId, "grant revoked");
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
      await revokeTerminateManaged(paneRow);
    }
    await auditSsh(caller.userId, "ssh.revoke", "ssh_grant", grantId, {
      connectionId: conn.id,
      subshellId,
    });
  }
  return { revoked: true };
}

/**
 * Terminate one managed terminal because the grant that opened it was revoked
 * (spec §2: "cancels runs/terminals initiated under that grant where
 * reachable"). The act is C's ordinary lifecycle teardown - the manager's
 * `terminateSubshell`, the same kill-then-retire every terminate surface
 * runs, keyed by the ROW's owner (whoever the pane belongs to), never by the
 * revoking caller.
 *
 * The offline half is why no new pending flag exists: `terminateSubshell` on
 * an unreachable node still RETIRES the row (kill UNVERIFIED) and the node's
 * own reconnect census (`SubshellManagerService.applySubshellsReport`)
 * best-effort-kills any pane that reports itself alive under a terminated
 * row - which is "stays pending, dispatched on reconnect before new work"
 * expressed through the lifecycle machinery that already enforces it, not a
 * second source of truth. A throw (a node that refused the kill) leaves the
 * row running and fenced: the generation raise above already refuses its
 * queued input and the closed streams above already stopped its readers, so
 * a failed kill must never fail the durable half of the revocation.
 */
async function revokeTerminateManaged(paneRow: SubshellTable): Promise<void> {
  if (paneRow.status !== "running") return; // parked or retired: nothing to stop
  try {
    await paneManager.terminateSubshell(paneRow.userId, paneRow.id);
  } catch (err) {
    logger.withError(err).warn(`ssh revocation terminate of managed pane ${paneRow.id} deferred (row stays fenced)`);
  }
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
