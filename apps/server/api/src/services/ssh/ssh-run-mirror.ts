import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import {
  parseSshConnectionSnapshot,
  type SshConnectionSnapshotWire,
  type SshRunFactsWire,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import type { SshRunTable } from "@/db/types/ssh-runs.db-types.js";
import type { SshRunView } from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { sshNodeGate } from "@/services/ssh/ssh-node.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { refuseSshDecision } from "@/services/ssh/ssh-refusal.js";
import { SshRunsRepository } from "@/services/ssh/ssh-runs.repository.js";

/**
 * The shared plumbing behind the runs services (review fix M-2 split it out
 * of the 440-line `ssh-runs.service.ts`): the mirror's repository handle,
 * the authorization loader every runs surface shares, the honest settle, and
 * the frozen-view projection. `ssh-runs.service.ts` (start/dispatch) and
 * `ssh-run-reads.service.ts` (read/get/list/cancel) build on this;
 * revocation and reconciliation reach the fold and the repository through it
 * too, so the mirror has exactly one writer vocabulary.
 */

const runs = new SshRunsRepository(db);

/** The runs repository for sibling SSH modules (retention, reconcile, grants, reads). */
export function sshRunsRepo(): SshRunsRepository {
  return runs;
}

/** A row the caller has already been gated for; gone between reads is a 404. */
export async function requireRow(runId: string): Promise<SshRunTable> {
  const row = await runs.findById(runId);
  if (!row) refuseSshDecision({ allow: false, code: "not_found" });
  return row;
}

/**
 * Load a run and route its authorization through the policy. Three kinds,
 * because the node-eligibility fact each needs differs and the policy doc
 * says the gate must refuse what the operation cannot do:
 * - `relay`: the output read moves through the connecting node now, so both
 *   arms require the node to answer (the granted arm's `run_read` already
 *   dispatch-checks; the human arm adds the check for a run whose connection
 *   row is gone - retained history on a live node is still readable).
 * - `facts`: the mirror answers itself. The HUMAN arm reads its own history
 *   with no node requirement (§4's retained-history rule); the GRANTED arm
 *   still rides the full `run_read` recheck, node eligibility included - §2's
 *   "every operation rechecks" sentence is stated for pane use, and a pane
 *   is the arm prompt-injection reaches.
 * - `cancel`: the request is local and the dispatch is pended-when-offline,
 *   so NO node requirement (refusing offline cancellation would make the
 *   spec's pending rule unreachable).
 */
export async function requireRunRow(
  caller: SshCaller,
  runId: string,
  kind: "relay" | "facts" | "cancel",
): Promise<SshRunTable> {
  const row = await runs.findById(runId);
  if (!row) refuseSshDecision({ allow: false, code: "not_found" });
  const policy = getSshPolicy();
  if (caller.actor === "cookie") {
    if (row.userId !== caller.userId) refuseSshDecision({ allow: false, code: "not_found" });
    if (kind === "facts") return row;
    const action = kind === "relay" ? "run_read" : "run_cancel";
    if (row.connectionId !== null) {
      const gate = await policy.gateHumanConfig({ caller, action, connectionId: row.connectionId });
      if (!gate.allow) refuseSshDecision(gate);
    } else if (kind === "relay") {
      // Connection-less history (deleted source) on a still-known node: the
      // same eligibility arm the named route would take, asked directly.
      if (row.nodeId !== null) {
        const gate = await sshNodeGate(caller, row.nodeId, "dispatch_rpc");
        if (!gate.allow) refuseSshDecision(gate);
      }
    }
    return row;
  }
  const gate = await policy.gateGrantedUse({
    caller,
    kind: kind === "cancel" ? "run_cancel" : "run_read",
    runId,
  });
  if (!gate.allow) refuseSshDecision(gate);
  return row;
}

/**
 * Move an unresolved mirror to `unknown` exactly once, and audit the
 * lifecycle OUTCOME (never a command echo). A row that already settled keeps
 * its earlier honest value - the first observation wins.
 */
export async function settleIfUnresolved(row: SshRunTable, lifecycle: "unknown"): Promise<SshRunTable> {
  if (row.status === "completed" || row.status === "unknown") return row;
  await runs.applyFacts(row.id, {
    runId: row.id,
    lifecycle,
    cancelRequested: row.cancelRequested === 1,
    cancelLocalConfirmed: row.cancelLocalConfirmed === 1,
    deadlineHit: row.deadlineHit === 1,
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
    localExitSignal: null,
  });
  await auditSsh(row.userId, "ssh.run.lifecycle", "ssh_run", row.id, { outcome: lifecycle, reason: "node_lost" });
  return (await runs.findById(row.id)) ?? row;
}

/** Fold a node facts answer into the mirror (reconcile and revocation passes share it). */
export async function applyRunFacts(runId: string, facts: SshRunFactsWire): Promise<void> {
  await runs.applyFacts(runId, facts);
}

/** Clamp into the frozen bound, flooring (never rounding up a caller's request). */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}

/** The stored per-run snapshot, re-validated like every other snapshot read. */
function runSnapshot(row: SshRunTable): SshConnectionSnapshotWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.configSnapshot);
  } catch {
    parsed = null;
  }
  const snapshot = parseSshConnectionSnapshot(parsed);
  if (snapshot === null) {
    throwApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "The stored run snapshot failed validation",
    });
  }
  return snapshot;
}

/** Project the mirror onto the frozen view; `command` rides owner/granted reads only. */
export function toRunView(row: SshRunTable): SshRunView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionRevision: row.connectionRevision,
    nodeId: row.nodeId,
    snapshot: runSnapshot(row),
    initiatedBy: row.initiatedBy,
    status: row.status,
    cancelRequested: row.cancelRequested === 1,
    cancelLocalConfirmed: row.cancelLocalConfirmed === 1,
    deadlineHit: row.deadlineHit === 1,
    deadlineMs: row.deadlineMs,
    remoteStatus: row.remoteStatus,
    remoteStatusConfirmed: row.remoteStatusConfirmed === 1,
    localExitCode: row.localExitCode,
    localExitSignal: row.localExitSignal,
    command: row.command,
    remoteDir: row.remoteDir,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
