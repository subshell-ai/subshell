import { createHash, randomUUID } from "node:crypto";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import {
  parseSshConnectionSnapshot,
  SSH_ACTIVE_RUNS_PER_NODE,
  SSH_ACTIVE_RUNS_PER_OWNER_PER_NODE,
  SSH_COMMAND_MAX_CHARS,
  SSH_OUTPUT_WINDOW_MAX_BYTES,
  SSH_READ_LONG_POLL_MAX_MS,
  SSH_RUN_DEADLINE_DEFAULT_MS,
  SSH_RUN_DEADLINE_MAX_MS,
  type SshConnectionSnapshotWire,
  type SshRunFactsWire,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import type { SshRunTable } from "@/db/types/ssh-runs.db-types.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type {
  SshRunCancelView,
  SshRunListView,
  SshRunOutputQuery,
  SshRunOutputView,
  SshRunStartRequest,
  SshRunView,
} from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { readStoredSnapshot, validateRemoteDir } from "@/services/ssh/ssh-connections.service.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { sshNodeGate } from "@/services/ssh/ssh-node.js";
import {
  bestEffortRunCancel,
  nodeSshRunRead,
  nodeSshRunStart,
  SshNodeRefusal,
} from "@/services/ssh/ssh-node-client.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { refuseSshDecision, refuseSshErrorCode } from "@/services/ssh/ssh-refusal.js";
import { SshRunsRepository } from "@/services/ssh/ssh-runs.repository.js";
import { logger } from "@/utils/logger.js";

/**
 * The runs domain (SSH-SUPPORT.md §3 Structured commands + Durable dispatch).
 *
 * The row IS the dedup record: the id is server-allocated before anything
 * moves, the `requestDigest` binds the complete deciding payload (snapshot,
 * directory, command, deadline - the node re-checks it on a duplicate
 * delivery), and the mirror is written before the RPC so a crash here leaves
 * an `accepted` row the reconcile pass will re-ask, never a phantom. A
 * dispatch the node REFUSED before accepting rolls the never-accepted row
 * back; a transport failure leaves the row `accepted` on purpose - the run
 * may exist node-side and only the node knows, which is exactly what
 * reconciliation and the no-automatic-replay rule are for.
 *
 * Output is NOT stored here: the plane relays the node's bounded window
 * through authorized reads and keeps metadata only (§3's storage rule).
 */

const runs = new SshRunsRepository(db);
const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);

/** The list tail every runs list answers with (a bounded recent window, not a cursor). */
export const SSH_RUNS_LIST_TAIL = 100;

/** `POST /api/ssh/runs`: the gated, quota-checked, digest-bound dispatch. */
export async function sshRunStart(caller: SshCaller, body: SshRunStartRequest): Promise<SshRunView> {
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

/**
 * `GET /api/ssh/runs/:id/output`: gated, bounded RELAY of the node-retained
 * output. A closing browser or a timed-out wait answers normally and cancels
 * NOTHING (spec §3, verbatim); an offset past retained output answers
 * `cursorExpired` - the caller restarts from 0, never silently reuses the
 * dead cursor (the explicit-reset rule §3's rotation paragraph demands).
 */
export async function sshRunRead(
  caller: SshCaller,
  runId: string,
  query: SshRunOutputQuery,
): Promise<SshRunOutputView> {
  const row = await requireRunRow(caller, runId, "relay");
  if (row.nodeId === null) {
    // The node is gone; its output store went with it. The facts stay, the
    // window cannot be answered, and the honest cursor state is "expired".
    const settled = await settleIfUnresolved(row, "unknown");
    return emptyWindow(settled, true);
  }
  const maxBytes = clamp(query.maxBytes ?? SSH_OUTPUT_WINDOW_MAX_BYTES, 1, SSH_OUTPUT_WINDOW_MAX_BYTES);
  const waitMs = clamp(query.waitMs ?? 0, 0, SSH_READ_LONG_POLL_MAX_MS);
  const stdoutFromByte = Math.max(0, Math.floor(query.stdoutFromByte ?? 0));
  const stderrFromByte = Math.max(0, Math.floor(query.stderrFromByte ?? 0));
  try {
    const result = await nodeSshRunRead(row.nodeId, { runId, stdoutFromByte, stderrFromByte, maxBytes, waitMs });
    await runs.applyFacts(runId, result);
    return {
      run: toRunView(await requireRow(runId)),
      stdout: decode(result.stdoutB64),
      stderr: decode(result.stderrB64),
      stdoutNext: result.stdoutNext,
      stderrNext: result.stderrNext,
      stdoutTotal: result.stdoutTotal,
      stderrTotal: result.stderrTotal,
      truncated: result.truncated,
      cursorExpired: stdoutFromByte > result.stdoutTotal || stderrFromByte > result.stderrTotal,
    };
  } catch (err) {
    if (err instanceof SshNodeRefusal && err.code === "run_unknown") {
      // The node has no record: the history expired or the acceptance crashed
      // before it. `unknown` is the honest settle - never failed, never
      // successful, and the window is whatever is retained: nothing.
      const settled = await settleIfUnresolved(row, "unknown");
      return emptyWindow(settled, true);
    }
    if (err instanceof SshNodeRefusal && err.transport) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "the connecting node cannot answer an output read right now",
        doNotLog: true,
      });
    }
    throw err;
  }
}

/** `GET /api/ssh/runs/:id`: the mirror's facts, no dispatch. */
export async function sshRunGet(caller: SshCaller, runId: string): Promise<SshRunView> {
  return toRunView(await requireRunRow(caller, runId, "facts"));
}

/**
 * `GET /api/ssh/runs`: the caller's recent runs, newest first, tail bounded.
 * Human: their own rows. Pane: rows its CURRENT credential initiated (runs a
 * pane started under an old key are not its recovery list - no
 * grandfathering, §2). No policy gate dispatches here because no act
 * dispatches: visibility is row-ownership on the caller's own identity, the
 * same projection the subshell list gives a bearer.
 */
export async function sshRunList(caller: SshCaller): Promise<SshRunListView> {
  if (caller.actor === "cookie") {
    return { runs: (await runs.listRecentByOwner(caller.userId, SSH_RUNS_LIST_TAIL)).map(toRunView) };
  }
  if (caller.actor !== "subshell-key" || caller.apiKeyId === null) return { runs: [] };
  return { runs: (await runs.listRecentByCredential(caller.apiKeyId, SSH_RUNS_LIST_TAIL)).map(toRunView) };
}

/**
 * `POST /api/ssh/runs/:id/cancel`: the REQUEST is the local fact (recorded
 * first, always); the DISPATCH is best-effort. An offline node keeps the
 * cancellation pending, and the reconnect pass dispatches it before any new
 * work (spec §2's offline rule) - this call answers the mirror either way,
 * with `cancelLocalConfirmed` saying what the node actually confirmed.
 */
export async function sshRunCancel(caller: SshCaller, runId: string): Promise<SshRunCancelView> {
  const row = await requireRunRow(caller, runId, "cancel");
  await runs.markCancelRequested(runId);
  await auditSsh(caller.userId, "ssh.run.cancel", "ssh_run", runId, { nodeId: row.nodeId });
  if (row.nodeId !== null && getLive(row.nodeId)) {
    const facts = await bestEffortRunCancel(row.nodeId, runId);
    if (facts) await runs.applyFacts(runId, facts);
  }
  return toRunView(await requireRunRow(caller, runId, "cancel"));
}

/* ------------------------------------------------------------------ */
/* shared plumbing                                                     */
/* ------------------------------------------------------------------ */

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
async function requireRunRow(
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

/** A row the caller has already been gated for; gone between reads is a 404. */
async function requireRow(runId: string): Promise<SshRunTable> {
  const row = await runs.findById(runId);
  if (!row) refuseSshDecision({ allow: false, code: "not_found" });
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

/** Fold a node facts answer into the mirror (reconcile and revocation passes share it). */
export async function applyRunFacts(runId: string, facts: SshRunFactsWire): Promise<void> {
  await runs.applyFacts(runId, facts);
}

/** The runs repository for sibling SSH modules (retention, reconcile, grants). */
export function sshRunsRepo(): SshRunsRepository {
  return runs;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}

/** UTF-8 LOSSY decode: output is data for a terminal, and a partial sequence must not 400 a read. */
function decode(b64: string): string {
  return b64 === "" ? "" : Buffer.from(b64, "base64").toString("utf8");
}

function emptyWindow(row: SshRunTable, cursorExpired: boolean): SshRunOutputView {
  return {
    run: toRunView(row),
    stdout: "",
    stderr: "",
    stdoutNext: 0,
    stderrNext: 0,
    stdoutTotal: 0,
    stderrTotal: 0,
    truncated: false,
    cursorExpired,
  };
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
