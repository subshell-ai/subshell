import { createHash, randomUUID } from "node:crypto";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import {
  SSH_ACTIVE_RUNS_PER_NODE,
  SSH_ACTIVE_RUNS_PER_OWNER_PER_NODE,
  SSH_COMMAND_MAX_CHARS,
  SSH_RUN_DEADLINE_DEFAULT_MS,
  SSH_RUN_DEADLINE_MAX_MS,
  type SshConnectionSnapshotWire,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import type { SshRunStartRequest, SshRunView } from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { readStoredSnapshot, validateRemoteDir } from "@/services/ssh/ssh-connections.service.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { nodeSshRunStart, SshNodeRefusal } from "@/services/ssh/ssh-node-client.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { refuseSshDecision, refuseSshErrorCode } from "@/services/ssh/ssh-refusal.js";
import { clamp, requireRow, sshRunsRepo, toRunView } from "@/services/ssh/ssh-run-mirror.js";
import { logger } from "@/utils/logger.js";

/**
 * The runs START/DISPATCH side (SSH-SUPPORT.md §3 Structured commands +
 * Durable dispatch; review fix M-2 split the read/cancel surface into
 * `ssh-run-reads.service.ts` and the shared plumbing into
 * `ssh-run-mirror.ts`).
 *
 * The row IS the dedup record: the id is server-allocated before anything
 * moves, the `requestDigest` binds the complete deciding payload (snapshot,
 * directory, command, deadline - the node re-checks it on a duplicate
 * delivery), and the mirror is written before the RPC so a crash here leaves
 * an `accepted` row the reconcile pass will re-ask, never a phantom. A
 * dispatch the node REFUSED before accepting rolls the never-accepted row
 * back; a transport failure leaves the row `accepted` on purpose - the run
 * may exist node-side and only the node knows, which is exactly what
 * reconciliation and the no-automatic-replay rule are for. Nothing in this
 * file ever re-dispatches.
 */

const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);

/** `POST /api/ssh/runs`: the gated, quota-checked, digest-bound dispatch. */
export async function sshRunStart(caller: SshCaller, body: SshRunStartRequest): Promise<SshRunView> {
  const runs = sshRunsRepo();
  const policy = getSshPolicy();
  const isHuman = caller.actor === "cookie";
  const gate = isHuman
    ? await policy.gateHumanConfig({ caller, action: "run_start", connectionId: body.connectionId })
    : await policy.gateGrantedUse({ caller, kind: "run_start", connectionId: body.connectionId });
  if (!gate.allow) refuseSshDecision(gate);

  const conn = await connections.findById(body.connectionId);
  if (!conn || conn.userId !== caller.userId) refuseSshDecision({ allow: false, code: "not_found" });

  if (body.command.length === 0 || body.command.length > SSH_COMMAND_MAX_CHARS) {
    throwApiError({
      code: BackendErrorCodes.BAD_REQUEST,
      message: `The command must be between 1 and ${SSH_COMMAND_MAX_CHARS} characters`,
      doNotLog: true,
    });
  }
  const remoteDir = body.remoteDir === undefined ? conn.remoteDir : validateRemoteDir(body.remoteDir);
  const deadlineMs = clamp(body.deadlineMs ?? SSH_RUN_DEADLINE_DEFAULT_MS, 1, SSH_RUN_DEADLINE_MAX_MS);
  const snapshot = readStoredSnapshot(conn);

  // Quotas first, both §3 rows (per-owner-per-node 4, per-node total 16):
  // counted on the PLANE's mirror before dispatch, because the plane
  // allocates the ids and the mirror is what the quota was promised against.
  if (
    (await runs.countActiveForOwnerNode(caller.userId, conn.nodeId)) >= SSH_ACTIVE_RUNS_PER_OWNER_PER_NODE ||
    (await runs.countActiveForNode(conn.nodeId)) >= SSH_ACTIVE_RUNS_PER_NODE
  ) {
    refuseSshErrorCode("quota_runs");
  }

  const runId = randomUUID();
  const requestDigest = digestOf({ snapshot, remoteDir, command: body.command, deadlineMs });
  const grant =
    !isHuman && caller.subshellId !== null && caller.apiKeyId !== null
      ? await grants.findActive(conn.id, caller.subshellId, caller.apiKeyId)
      : undefined;
  // The granted gate just CONFIRMED an active grant for this tuple; a row
  // revoked between the two reads is the race's answer, not a pass-through.
  if (!isHuman && !grant) refuseSshDecision({ allow: false, code: "grant_revoked" });

  await runs.create({
    id: runId,
    userId: caller.userId,
    nodeId: conn.nodeId,
    connectionId: conn.id,
    connectionRevision: conn.revision,
    configSnapshot: JSON.stringify(snapshot),
    initiatedBy: isHuman ? "human" : "agent",
    grantId: isHuman ? null : (grant?.id ?? null),
    apiKeyId: isHuman ? null : caller.apiKeyId,
    command: body.command,
    remoteDir,
    requestDigest,
    deadlineMs,
    status: "accepted",
    cancelRequested: 0,
    cancelLocalConfirmed: 0,
    deadlineHit: 0,
    remoteStatus: null,
    remoteStatusConfirmed: 0,
    localExitCode: null,
    localExitSignal: null,
    startedAt: null,
    finishedAt: null,
  });
  await auditSsh(caller.userId, "ssh.run.start", "ssh_run", runId, {
    connectionId: conn.id,
    connectionRevision: conn.revision,
    nodeId: conn.nodeId,
    initiatedBy: isHuman ? "human" : "agent",
  });

  try {
    const facts = await nodeSshRunStart(conn.nodeId, {
      runId,
      snapshot,
      remoteDir,
      command: body.command,
      deadlineMs,
      requestDigest,
    });
    await runs.applyFacts(runId, facts);
  } catch (err) {
    if (err instanceof SshNodeRefusal && err.code !== null) {
      // The node refused BEFORE accepting: no run exists anywhere, and a
      // mirror claiming `accepted` would invent a lifecycle. Roll the row
      // back (state-guarded: a settle that raced in is kept, not deleted)
      // and surface the named code.
      await runs.deleteIfUntouched(runId).catch(() => {});
      refuseSshErrorCode(err.code);
    }
    // Transport/unsupported: the fate is genuinely unknown to the plane. The
    // row stays `accepted` (the honest mirror of "we asked; we do not know")
    // and the reconcile-on-reconnect pass asks the node. NEVER re-dispatch
    // here: that is the automatic replay §3 forbids.
    logger.withError(err).warn(`ssh run ${runId} dispatch to node ${conn.nodeId} unresolved; row stays accepted`);
  }
  return toRunView(await requireRow(runId));
}

/** The §3 request binding: one canonical JSON over the deciding payload, sha256 lowercase hex. */
export function digestOf(parts: {
  snapshot: SshConnectionSnapshotWire;
  remoteDir: string | null;
  command: string;
  deadlineMs: number;
}): string {
  const canonical = JSON.stringify({
    snapshot: parts.snapshot,
    remoteDir: parts.remoteDir,
    command: parts.command,
    deadlineMs: parts.deadlineMs,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
