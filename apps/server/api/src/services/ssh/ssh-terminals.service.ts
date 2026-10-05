import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import { normalizeLabel, SSH_TERMINALS_PER_OWNER_PER_NODE } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { publishLive } from "@/services/live-bus.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type { SshTerminalCreateRequest, SshTerminalView } from "@/services/ssh/ssh-api-types.js";
import { auditSsh } from "@/services/ssh/ssh-audit.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { readStoredSnapshot } from "@/services/ssh/ssh-connections.service.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { nodeSshTerminalLaunch, SshNodeRefusal } from "@/services/ssh/ssh-node-client.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { refuseSshDecision, refuseSshErrorCode } from "@/services/ssh/ssh-refusal.js";

/**
 * Managed SSH terminals (SSH-SUPPORT.md §3 "Interactive terminals"). A
 * managed pane is an ordinary `subshells` row (rendering, geometry, attach
 * and lifecycle ride the existing pane plumbing behind workstream C's
 * policy-gated hooks) whose FOREGROUND process is ssh: the plane records the
 * row, dispatches `ssh_terminal_launch` (the node owns the argv under the
 * mandatory all-hop runtime policy - the `launch` inversion, and no local
 * shell fallback exists in that command), and marks the pane in `ssh_panes`
 * so the policy applies to every surface from then on.
 *
 * The create path deliberately does NOT call `SubshellsService.createSubshell`:
 * that path launches a HARNESS, and the SSH contract replaces the harness
 * process with ssh itself. What it does reuse, verbatim, is the row's shape
 * and the same node-eligibility facts the create path gates on (the §2 arm
 * runs through `gateHumanConfig`/`gateGrantedUse` plus the shared `sshNodeGate`).
 */

const panes = new SshPanesRepository(db);
const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);
const subshells = new SubshellsRepository(db);

/**
 * `POST /api/ssh/terminals`: open a managed terminal on a connection.
 * Human-opened panes START IN HUMAN CONTROL; agent-opened ones in agent
 * control (spec §3, verbatim). Quota (4 per owner per node), node
 * eligibility (refused while the connecting node is offline), and terminal
 * refusal for a pane whose own row is a managed terminal all land BEFORE
 * anything spawns.
 */
export async function sshTerminalCreate(caller: SshCaller, body: SshTerminalCreateRequest): Promise<SshTerminalView> {
  const policy = getSshPolicy();
  const isHuman = caller.actor === "cookie";
  const gate = isHuman
    ? await policy.gateHumanConfig({ caller, action: "terminal_open", connectionId: body.connectionId })
    : await policy.gateGrantedUse({ caller, kind: "terminal_open", connectionId: body.connectionId });
  if (!gate.allow) refuseSshDecision(gate);

  const conn = await connections.findById(body.connectionId);
  if (!conn || conn.userId !== caller.userId) refuseSshDecision({ allow: false, code: "not_found" });

  // An agent that is itself a managed terminal may not open terminals (no
  // terminal-of-a-terminal chains; C's pane gate keeps the rest honest, this
  // keeps the count honest).
  if (caller.subshellId !== null && (await panes.findBySubshell(caller.subshellId))) {
    refuseSshDecision({ allow: false, code: "not_found" });
  }

  if ((await panes.countLiveForOwnerNode(caller.userId, conn.nodeId)) >= SSH_TERMINALS_PER_OWNER_PER_NODE) {
    refuseSshErrorCode("quota_terminals");
  }

  const snapshot = readStoredSnapshot(conn);
  const remoteDir = conn.remoteDir;
  const id = randomUUID();
  const socket = tmuxSocketFor(id);
  const terminalHarness = getHarness("terminal");
  if (terminalHarness === undefined) {
    throwApiError({
      code: BackendErrorCodes.INTERNAL_SERVER_ERROR,
      message: "The built-in terminal harness is not available on this instance",
    });
  }

  const initiatedBy = isHuman ? "human" : "agent";
  const grant =
    !isHuman && caller.subshellId !== null && caller.apiKeyId !== null
      ? await grants.findActive(conn.id, caller.subshellId, caller.apiKeyId)
      : undefined;
  if (!isHuman && !grant) refuseSshDecision({ allow: false, code: "grant_revoked" });

  // The row first (the create path's own ordering: INSERT, launch, settle).
  // `workingDir` is the node's own home from its `ready` facts - the pane's
  // local cwd is irrelevant to an ssh-foregrounded window, but the column is
  // not-null and every pane view renders it; homeDir is what a connecting
  // user sees before the first remote byte. The `local` node reports no agent
  // `ready` facts (it is this process), so its home is the server account's
  // own - the same home `ssh-local.ts` connects from (review I3).
  const facts = conn.nodeId === LOCAL_NODE_ID ? null : getLive(conn.nodeId)?.agent;
  const localHome = conn.nodeId === LOCAL_NODE_ID ? process.env.HOME || homedir() : null;
  await subshells.create({
    id,
    userId: caller.userId,
    harnessId: "terminal",
    name: normalizeLabel(`SSH ${conn.displayName}`, 120),
    workingDir: facts?.homeDir ?? localHome ?? "/",
    presetId: null,
    nodeId: conn.nodeId,
    tmuxSocket: socket,
    status: "running",
    alive: 1,
    startedAt: new Date().toISOString(),
    // Agent-opened panes are born silent and filed under the agent-created
    // grouping, exactly the create route's `crossAgent` posture (§39).
    notify: isHuman ? 1 : 0,
    crossAgent: isHuman ? 0 : 1,
  });

  try {
    await nodeSshTerminalLaunch(conn.nodeId, {
      subshellId: id,
      socket,
      snapshot,
      remoteDir,
      ...(body.cols === undefined ? {} : { cols: body.cols }),
      ...(body.rows === undefined ? {} : { rows: body.rows }),
    });
  } catch (err) {
    // Nothing is running and nothing ever was, so no row may claim otherwise:
    // the pane row goes entirely (the create path's launch-refusal posture).
    await subshells.delete(id).catch(() => {});
    if (err instanceof SshNodeRefusal && err.code !== null) refuseSshErrorCode(err.code);
    if (err instanceof SshNodeRefusal && err.transport) {
      throwApiError({
        code: BackendErrorCodes.NODE_OFFLINE,
        message: "the connecting node could not open the terminal",
        doNotLog: true,
      });
    }
    throw err;
  }

  const pane = await panes.create({
    subshellId: id,
    connectionId: conn.id,
    connectionRevision: conn.revision,
    initiatedBy,
    grantId: isHuman ? null : (grant?.id ?? null),
    apiKeyId: isHuman ? null : caller.apiKeyId,
    // Human-opened starts in HUMAN control; agent-opened in AGENT control
    // (§3 verbatim; only humans ever move it back).
    controlOwner: initiatedBy,
    controlGeneration: 1,
    logGeneration: 1,
  });
  // A pane write a person should see announces itself (AGENTS.md); the rail
  // learns of the new terminal through the ordinary subshell.changed feed.
  publishLive({ kind: "subshell.changed", id });
  await auditSsh(caller.userId, "ssh.terminal.open", "ssh_pane", id, {
    connectionId: conn.id,
    connectionRevision: conn.revision,
    nodeId: conn.nodeId,
    initiatedBy,
  });
  return {
    subshellId: pane.subshellId,
    connectionId: pane.connectionId,
    connectionRevision: pane.connectionRevision,
    initiatedBy: pane.initiatedBy,
    controlOwner: pane.controlOwner,
    controlGeneration: pane.controlGeneration,
    logGeneration: pane.logGeneration,
    createdAt: pane.createdAt,
  };
}

// No `sshControlTransition` lives here (review I5). The takeover/return act is
// the ONE registered path in `pane-ssh-gate.ts::transitionPaneControl` (node-
// first mirror, streams closed on the raise commit); this was a dead second
// implementation with the INVERTED contract - it moved the plane row
// (`setControl`) BEFORE telling the node, and never closed viewer streams, so
// a takeover through it fenced only the plane's copy while the machine kept
// accepting stale queued input and live sockets kept streaming. Only tests
// imported it; `POST /api/subshells/:id/ssh-control` and the revocation sweep
// both drive the registered act. A second takeover act is a second contract to
// keep honest, and the honest one already exists.
