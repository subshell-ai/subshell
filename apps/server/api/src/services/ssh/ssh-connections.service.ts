import { randomUUID } from "node:crypto";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import {
  type NodeSshAliasListResult,
  normalizeLabel,
  parseSshConnectionSnapshot,
  SSH_FORBIDDEN_SNAPSHOT_FIELDS,
  SSH_PATH_MAX_CHARS,
  type SshConnectionSnapshotWire,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import type { SshConnectionTable } from "@/db/types/ssh-connections.db-types.js";
import type {
  SshConnectionListView,
  SshConnectionView,
  SshCreateConnectionRequest,
  SshDiscoveryView,
  SshResolveRequest,
  SshResolveView,
  SshTestConnectionRequest,
  SshTestConnectionView,
  SshUpdateConnectionRequest,
} from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { sshNodeGate } from "@/services/ssh/ssh-node.js";
import { nodeSshDiscover, nodeSshResolve, nodeSshTest, SshNodeRefusal } from "@/services/ssh/ssh-node-client.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { refuseSshDecision, refuseSshErrorCode } from "@/services/ssh/ssh-refusal.js";

/**
 * The connections domain (SSH-SUPPORT.md §2/§3/§4): discovery, resolution,
 * the fixed test, save/edit/delete with revision discipline, and the two
 * read projections (owner settings list, granted pane's filtered list).
 *
 * Canonical-form strictness lives HERE at the save gate (Gate A's contract
 * fact): every snapshot - resolved, tested, saved, re-saved - is run through
 * the protocol's `parseSshConnectionSnapshot` BEFORE it is stored or
 * dispatched, so the grammar that refuses a `ProxyCommand` is what the plane
 * enforces, not the resolver's politeness. Reads re-validate too ("both
 * sides call it"); a stored value that no longer parses is a broken row,
 * reported as a server fault, never shipped as a connection.
 */

const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);

/** `GET /api/ssh/discovery?nodeId=`: alias NAMES on an eligible node, human cookie only. */
export async function sshDiscovery(caller: SshCaller, nodeId: string): Promise<SshDiscoveryView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "discover" });
  if (!gate.allow) refuseSshDecision(gate);
  const eligibility = await sshNodeGate(caller, nodeId, "dispatch_rpc");
  if (!eligibility.allow) refuseSshDecision(eligibility);
  let result: NodeSshAliasListResult;
  try {
    result = await nodeSshDiscover(nodeId);
  } catch (err) {
    throw mapNodeFailure(err, "discovery");
  }
  await auditSsh(caller.userId, "ssh.discover", "node", nodeId, {});
  return { aliases: result.aliases, includeCycle: result.includeCycle, truncated: result.truncated };
}

/** `POST /api/ssh/connections/resolve`: the reviewable outcome of one alias, human-only. */
export async function sshResolve(caller: SshCaller, body: SshResolveRequest): Promise<SshResolveView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "resolve" });
  if (!gate.allow) refuseSshDecision(gate);
  const eligibility = await sshNodeGate(caller, body.nodeId, "dispatch_rpc");
  if (!eligibility.allow) refuseSshDecision(eligibility);
  let outcome;
  try {
    outcome = await nodeSshResolve(body.nodeId, body.alias);
  } catch (err) {
    throw mapNodeFailure(err, "resolution");
  }
  await auditSsh(caller.userId, "ssh.resolve", "node", body.nodeId, {
    accepted: outcome.accepted,
    ...(outcome.accepted ? {} : { code: outcome.code }),
  });
  if (!outcome.accepted) return { accepted: false, code: outcome.code, settings: outcome.settings };
  // The plane re-runs the grammar before showing the snapshot as approvable:
  // a resolver bug that produced a `ProxyCommand` meets the same parser here
  // as it would at every later dispatch, and the human never sees a snapshot
  // the save would refuse.
  const snapshot = validateSnapshotForSave(outcome.snapshot);
  return {
    accepted: true,
    snapshot,
    ...(outcome.connectingAccount !== undefined ? { connectingAccount: outcome.connectingAccount } : {}),
  };
}

/** `POST /api/ssh/connections/test`: the FIXED benign probe against an approved snapshot. */
export async function sshTestConnection(
  caller: SshCaller,
  body: SshTestConnectionRequest,
): Promise<SshTestConnectionView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "test" });
  if (!gate.allow) refuseSshDecision(gate);
  const eligibility = await sshNodeGate(caller, body.nodeId, "dispatch_rpc");
  if (!eligibility.allow) refuseSshDecision(eligibility);
  const snapshot = validateSnapshotForSave(body.snapshot);
  let outcome;
  try {
    outcome = await nodeSshTest(body.nodeId, snapshot);
  } catch (err) {
    throw mapNodeFailure(err, "connection test");
  }
  await auditSsh(caller.userId, "ssh.test", "node", body.nodeId, {
    passed: outcome.passed,
    ...(outcome.passed ? {} : { code: outcome.code }),
  });
  return outcome;
}

/** `POST /api/ssh/connections`: save a resolved snapshot at revision 1. */
export async function sshCreateConnection(
  caller: SshCaller,
  body: SshCreateConnectionRequest,
): Promise<SshConnectionView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "save" });
  if (!gate.allow) refuseSshDecision(gate);
  const eligibility = await sshNodeGate(caller, body.nodeId, "configure");
  if (!eligibility.allow) refuseSshDecision(eligibility);
  const snapshot = validateSnapshotForSave(body.snapshot);
  const row = await connections.create({
    id: randomUUID(),
    userId: caller.userId,
    nodeId: body.nodeId,
    displayName: labelOrRefuse(body.displayName),
    configSnapshot: JSON.stringify(snapshot),
    remoteDir: validateRemoteDir(body.remoteDir ?? null),
  });
  await auditSsh(caller.userId, "ssh.connection.create", "ssh_connection", row.id, {
    nodeId: row.nodeId,
    revision: row.revision,
    alias: snapshot.alias,
    host: snapshot.host,
  });
  return toView(row);
}

/**
 * `PATCH /api/ssh/connections/:id`: every edit is gated for ACTIVE WORK
 * first (spec §2: "Refuse edits while work is active; the human must stop or
 * finish it first"), and a snapshot-bearing edit is ONE statement that moves
 * the snapshot and the revision together - so a grant never sees the new
 * config under the old number (the atomic invalidation §2's revision rule).
 */
export async function sshUpdateConnection(
  caller: SshCaller,
  connectionId: string,
  body: SshUpdateConnectionRequest,
): Promise<SshConnectionView> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "edit", connectionId });
  if (!gate.allow) refuseSshDecision(gate);
  const row = await requireOwned(connectionId, caller);
  if (body.snapshot === undefined && body.displayName === undefined && body.remoteDir === undefined) {
    // A no-field PATCH would bump nothing today, but "an edit that carries
    // no edit" is a caller bug the door names rather than absorbs.
    throwApiError({ code: BackendErrorCodes.BAD_REQUEST, message: "The edit carries no changes", doNotLog: true });
  }

  const patchLabel: { displayName?: string; remoteDir?: string | null } = {};
  if (body.displayName !== undefined) patchLabel.displayName = labelOrRefuse(body.displayName);
  if (body.remoteDir !== undefined) patchLabel.remoteDir = validateRemoteDir(body.remoteDir);
  const labelOnly = Object.keys(patchLabel).length > 0 && body.snapshot === undefined;
  if (labelOnly) {
    await connections.updateLabel(row.id, patchLabel);
  } else {
    const snapshot = validateSnapshotForSave(body.snapshot ?? readStoredSnapshot(row));
    await connections.updateSnapshot(row.id, {
      configSnapshot: JSON.stringify(snapshot),
      ...(body.displayName !== undefined ? { displayName: patchLabel.displayName } : {}),
      ...(body.remoteDir !== undefined ? { remoteDir: patchLabel.remoteDir } : {}),
    });
  }
  const updated = await requireOwned(connectionId, caller);
  await auditSsh(caller.userId, "ssh.connection.update", "ssh_connection", row.id, {
    revision: updated.revision,
    snapshotChanged: !labelOnly,
  });
  return toView(updated);
}

/** `DELETE /api/ssh/connections/:id`: refused while work is active (policy arm), then the row goes. */
export async function sshDeleteConnection(caller: SshCaller, connectionId: string): Promise<{ deleted: true }> {
  const gate = await getSshPolicy().gateHumanConfig({ caller, action: "delete_connection", connectionId });
  if (!gate.allow) refuseSshDecision(gate);
  const row = await requireOwned(connectionId, caller);
  await connections.delete(row.id);
  await auditSsh(caller.userId, "ssh.connection.delete", "ssh_connection", row.id, {
    revision: row.revision,
    alias: readStoredSnapshot(row).alias,
  });
  return { deleted: true };
}

/**
 * The connections LIST, both projections:
 * - human cookie: the owner's rows, newest first.
 * - granted pane: ONLY connections with an active grant for its CURRENT key
 *   whose pinned revision still matches the connection (§2: "MCP lists only
 *   the connections granted to the caller" - a mismatched grant is dead use,
 *   not a visible row). Foreign rows never appear in any list, anyone's.
 */
export async function sshListConnections(caller: SshCaller): Promise<SshConnectionListView> {
  if (caller.actor === "cookie") {
    const rows = await connections.listByOwner(caller.userId);
    return { connections: rows.map(toView) };
  }
  if (caller.actor !== "subshell-key" || caller.subshellId === null || caller.apiKeyId === null) {
    return { connections: [] };
  }
  const paneGrants = (await grants.listActiveForPane(caller.subshellId)).filter((g) => g.apiKeyId === caller.apiKeyId);
  const visible: SshConnectionView[] = [];
  for (const grant of paneGrants) {
    const conn = await connections.findById(grant.connectionId);
    if (!conn || conn.userId !== caller.userId) continue;
    if (conn.revision !== grant.connectionRevision) continue;
    visible.push(toView(conn));
  }
  return { connections: visible };
}

/**
 * `GET /api/ssh/connections/:id`: owner human, or a pane with a live grant
 * for the CURRENT revision (through the granted arm, which re-asks token,
 * pane, grant and revision). The human arm needs no policy call: the §4
 * caller column for reads is plain ownership, and `requireOwned` is the same
 * row-read predicate the human gate applies - there is no named human VIEW
 * action in the frozen action set precisely because it adds no fact beyond
 * that read, and a detail read dispatches nothing.
 */
export async function sshGetConnection(caller: SshCaller, connectionId: string): Promise<SshConnectionView> {
  if (caller.actor === "cookie") return toView(await requireOwned(connectionId, caller));
  const gate = await getSshPolicy().gateGrantedUse({ caller, kind: "connection_view", connectionId });
  if (!gate.allow) refuseSshDecision(gate);
  const row = await connections.findById(connectionId);
  if (!row) return refuseSshDecision({ allow: false, code: "not_found" });
  return toView(row);
}

/* ------------------------------------------------------------------ */
/* shared plumbing                                                     */
/* ------------------------------------------------------------------ */

/** The row, or the 404 convention - the caller is already gated, so a miss is foreign-or-gone. */
export async function requireOwned(connectionId: string, caller: SshCaller): Promise<SshConnectionTable> {
  const row = await connections.findById(connectionId);
  if (!row || row.userId !== caller.userId) {
    refuseSshDecision({ allow: false, code: "not_found" });
  }
  return row;
}

/**
 * Validate a candidate snapshot with the frozen grammar and refuse by NAME:
 * a present forbidden member is `unsupported_setting` (the §2 rule - never a
 * silent drop), anything the grammar cannot express is a plain 400, because
 * the caller sent a shape that was never a snapshot.
 */
export function validateSnapshotForSave(value: unknown): SshConnectionSnapshotWire {
  const snapshot = parseSshConnectionSnapshot(value);
  if (snapshot !== null) return snapshot;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const blocked = SSH_FORBIDDEN_SNAPSHOT_FIELDS.filter((f) => record[f] != null);
    if (blocked.length > 0) refuseSshErrorCode("unsupported_setting", blocked.join(", "));
  }
  throwApiError({
    code: BackendErrorCodes.BAD_REQUEST,
    message: "The snapshot does not match the approved connection grammar",
    doNotLog: true,
  });
}

/** The stored snapshot, re-validated (a row that stopped parsing is a broken row, not a connection). */
export function readStoredSnapshot(row: SshConnectionTable): SshConnectionSnapshotWire {
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
      message: "The stored connection snapshot failed validation",
    });
  }
  return snapshot;
}

/**
 * Remote-directory validation: the WIRE grammar (absolute, length-capped, no
 * whitespace or control characters) applies at the API door too, so a bad
 * value refuses where it is typed rather than failing at the node with a
 * less locatable sentence. Spaces are refused by the frozen grammar on
 * purpose - quoting rules are §2's "quote remote directory arguments as
 * POSIX data", and the wire keeps the shape simple.
 */
export function validateRemoteDir(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.startsWith("/") || value.length > SSH_PATH_MAX_CHARS || /[\s\p{Cc}]/u.test(value)) {
    throwApiError({
      code: BackendErrorCodes.BAD_REQUEST,
      message: "The remote directory must be an absolute POSIX path without spaces or control characters",
      doNotLog: true,
    });
  }
  return value;
}

/** Display labels follow the house rule: normalized, capped, and a refusal rather than a silent empty. */
function labelOrRefuse(raw: string): string {
  const label = normalizeLabel(raw, 120);
  if (label === "") {
    throwApiError({ code: BackendErrorCodes.BAD_REQUEST, message: "The display name is empty", doNotLog: true });
  }
  return label;
}

/**
 * Project a stored row onto the frozen REST shape. Reads never return the
 * stored TEXT: the snapshot comes back re-validated, so what the SPA and MCP
 * hold is a grammar-checked destination, never raw bytes from a JSON column.
 */
function toView(row: SshConnectionTable): SshConnectionView {
  return {
    id: row.id,
    nodeId: row.nodeId,
    displayName: row.displayName,
    snapshot: readStoredSnapshot(row),
    remoteDir: row.remoteDir,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Map an adapter failure to the API: named codes first, then the transport family. */
function mapNodeFailure(err: unknown, verb: string): Error {
  if (err instanceof SshNodeRefusal) {
    if (err.code !== null) refuseSshErrorCode(err.code, verb);
    if (err.transport) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: `the connecting node could not answer ${verb}`,
        doNotLog: true,
      });
    }
    throwApiError({
      code: BackendErrorCodes.NODE_UNREACHABLE,
      message: err.malformed ? `the connecting node answered ${verb} with a malformed payload` : err.message,
      doNotLog: !err.malformed,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}
