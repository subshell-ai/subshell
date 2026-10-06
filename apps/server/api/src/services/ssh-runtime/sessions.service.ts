import { randomUUID } from "node:crypto";
import { getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import {
  type NodeFsLsResult,
  normalizeLabel,
  parseNodeFsLsResult,
  parseNodeSshSessionOpenResult,
  parseSshRuntimeHello,
  parseSshSessionTarget,
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSION_OPEN_DEADLINE_MS,
  SSH_SESSIONS_PER_NODE,
  type SshErrorCode,
  type SshRuntimeHelloWire,
  type SshSessionTargetWire,
  sshRuntimeProtocolSupported,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID, NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import type { SshRuntimeSessionStatus } from "@/db/types/ssh-runtime-sessions.db-types.js";
import { audit } from "@/services/audit.js";
import { announceNodePresence } from "@/services/nodes/node-presence-announce.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";
import { logger } from "@/utils/logger.js";
import { RuntimeSessionLauncher } from "./runtime-session-launcher.js";
import { SshRuntimeSession } from "./session.js";
import { getSession, registerSession, sessionHooks } from "./session-registry.js";
import { installSessionSettlers } from "./session-settle.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";

/**
 * The control-plane half of SSH runtime sessions (design 2026-10-05 §4):
 * open a brokered session through a node the caller OWNS, keep its row, and
 * launch ordinary `subshells` rows onto it so every pane surface works
 * unchanged. This is the LAUNCH PATH DECISION the slice was asked to make,
 * recorded in code: the hidden `nodes` row (kind `runtime`) plus the
 * registry branch in `launcher-registry.ts` is what the pane plumbing needs,
 * and it cost one column-value, one insert, and a three-line registry branch -
 * nothing heavier, and the alternative (session rows carrying node facts ad
 * hoc) would have forked every pane surface instead of reusing it.
 *
 * The lifecycle settling (lost/closed/exit/census, and the boot sweep that
 * marks rows lost when this process restarts) lives in `session-settle.ts`;
 * this module is the SERVICE DOOR (open/launch/list/close/view) and installs
 * those handlers at load.
 *
 * Authorization is the salvaged rule, restated rather than reached around:
 * opening requires the caller to OWN the connecting node - real ownership,
 * no admin boost, no share (the `sshNodeGate` agent arm's exact posture);
 * `local` is out of the slice's scope (its admin arm is an in-process broker
 * that would need `dispatchLocalSsh` to grow session verbs - workstream B/C
 * territory, and saying so is better than faking a half-arm).
 *
 * Version honesty (design §2): the runtime's `runtimeProtocol` is checked
 * against {@link SSH_RUNTIME_PROTOCOL} HERE, at the plane, and the refusal
 * names both numbers; the broker never interprets runtime frames beyond the
 * hello it was built to hand back.
 */

/** The settle handlers ride the shared hook object; installed once, before any session exists. */
installSessionSettlers();

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const nodesRepo = new NodesRepository(db);
const subshellsRepo = new SubshellsRepository(db);

/** A refusal the routes map to a named API error: the transport/eligibility facts are never guessed at the handler. */
export class SshRuntimeRefusal extends Error {
  readonly status: number;
  /** The named code when there is one (frozen `SshErrorCode` or `session_unknown`). */
  readonly code: SshErrorCode | "session_unknown" | null;
  constructor(status: number, message: string, code: SshRuntimeRefusal["code"] = null) {
    super(message);
    this.name = "SshRuntimeRefusal";
    this.status = status;
    this.code = code;
  }
}

/** The session view the routes serialize: facts, never refs to key material. */
export interface SshRuntimeSessionView {
  id: string;
  /**
   * The machine that brokered the child, or null when that row has since been
   * deleted (migration 0049's SET NULL: the session history outlives the
   * connecting machine).
   */
  connectingNodeId: string | null;
  runtimeNodeId: string;
  alias: string;
  host: string;
  port: number;
  user: string | null;
  /** The lifecycle union (the route's response schema is the same four literals). */
  status: SshRuntimeSessionStatus;
  hello: SshRuntimeHelloWire | null;
  createdAt: string;
  lastSeenAt: string | null;
  closedAt: string | null;
}

/**
 * Open one session. The order is the contract: gate (real ownership, live,
 * not maintenance) -> quota mirror -> DB rows (`opening` session + hidden
 * runtime node) -> brokered `ssh_session_open` (whose RPC timeout OUTLASTS the
 * node's own hello deadline, the pattern the run read long-poll set) ->
 * version check -> register + settle active. Every failure before `active`
 * unrolls what it wrote (the node's own supervisor does the same on its disk).
 */
export async function openSession(
  userId: string,
  body: { connectingNodeId: string; target: SshSessionTargetWire; runtimeCommand?: string },
): Promise<SshRuntimeSessionView> {
  // Target grammar BEFORE any write: the protocol's parser is the single
  // source of truth (the node re-runs it as defense in depth), and a refused
  // target must never leave an `opening` row or a hidden node behind. The
  // refusal carries no named code: this is review refusing the shape, not a
  // destination refusing an arrival.
  const target = parseSshSessionTarget(body.target);
  if (target === null) {
    throw new SshRuntimeRefusal(
      409,
      "the destination target is not plain session material (host, user, alias, and port all have a grammar)",
    );
  }
  const node = await nodesRepo.findById(body.connectingNodeId);
  if (!node || node.id === LOCAL_NODE_ID || node.kind !== "agent" || node.ownerUserId !== userId) {
    // One refusal for every shape of "that is not your enrolled machine":
    // 404-not-403, the non-enumerating convention the ssh gate kept.
    throw new SshRuntimeRefusal(404, "the connecting node was not found or is not yours");
  }
  if (node.maintenance === 1) throw new SshRuntimeRefusal(409, "the connecting node is in a maintenance window");
  if (!getLive(node.id)) throw new SshRuntimeRefusal(409, "the connecting node is offline");
  if ((await sessionsRepo.countActiveForNode(node.id)) >= SSH_SESSIONS_PER_NODE) {
    throw new SshRuntimeRefusal(409, "the connecting node carries its share of open sessions", "session_quota");
  }

  const sessionId = randomUUID();
  const runtimeNodeId = randomUUID();
  const nowIso = new Date().toISOString();
  await nodesRepo.create({
    id: runtimeNodeId,
    ownerUserId: userId,
    // The suffix keeps the per-owner name uniqueness rule true across
    // repeated sessions on the same destination (the row is hidden from
    // listings; the name only ever appears in pane tooltips).
    name: normalizeLabel(`SSH ${target.alias} ${sessionId.slice(0, 4)}`, 60),
    kind: NODE_KIND_RUNTIME,
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: nowIso,
  });
  await sessionsRepo.create({
    id: sessionId,
    ownerUserId: userId,
    connectingNodeId: node.id,
    runtimeNodeId,
    alias: target.alias,
    host: target.host,
    port: target.port,
    user: target.user,
  });

  let openData: unknown;
  try {
    // The node's own open answer is bounded by its hello deadline (spawn +
    // probe + hello); the RPC must outlast it and not race it (the read
    // long-poll's slack pattern).
    openData = await sendCommand(
      node.id,
      {
        type: "ssh_session_open",
        ref: sessionId,
        target: target,
        ...(body.runtimeCommand !== undefined && body.runtimeCommand !== ""
          ? { runtimeCommand: body.runtimeCommand }
          : {}),
      },
      { timeoutMs: SSH_SESSION_OPEN_DEADLINE_MS + 10_000 },
    );
  } catch (err) {
    await unrollOpening(sessionId, runtimeNodeId, err);
    throw mapOpenError(err);
  }
  const result = parseNodeSshSessionOpenResult(openData);
  if (result === null) {
    await unrollOpening(sessionId, runtimeNodeId, new Error("malformed open answer"));
    throw new SshRuntimeRefusal(502, "the node answered the session open with a malformed payload");
  }
  if (!sshRuntimeProtocolSupported(result.hello)) {
    await closeBestEffort(node.id, sessionId);
    await unrollOpening(sessionId, runtimeNodeId, new Error("runtime protocol mismatch"));
    throw new SshRuntimeRefusal(
      409,
      `the destination runtime speaks protocol ${result.hello.runtimeProtocol}; this plane speaks ${SSH_RUNTIME_PROTOCOL} - update the subshell binary on the destination`,
    );
  }

  const session = new SshRuntimeSession({
    id: sessionId,
    ownerId: userId,
    connectingNodeId: node.id,
    runtimeNodeId,
    target: target,
    hello: result.hello,
  });
  session.hooks = sessionHooks();
  registerSession(session);
  await sessionsRepo.settle(sessionId, "active", JSON.stringify(result.hello));
  await announceNodePresence(runtimeNodeId);
  await audit({
    actorUserId: userId,
    action: "ssh_runtime_session.open",
    targetType: "ssh_runtime_session",
    targetId: sessionId,
    metadataJson: JSON.stringify({ connectingNodeId: node.id, host: result.host, port: result.port }),
  });
  return viewOf(sessionId);
}

/** Ask the runtime for a directory listing (design §7's picker, §2's `list_dirs`). */
export async function sessionListDirs(sessionId: string, userId: string, path: string): Promise<NodeFsLsResult> {
  const session = requireOwnedSession(sessionId, userId);
  const data = await session.command({ type: "list_dirs", ref: crypto.randomUUID(), path }, 10_000);
  const parsed = parseNodeFsLsResult(data);
  if (parsed === null) throw new SshRuntimeRefusal(502, "the runtime answered the listing with a malformed payload");
  void sessionsRepo.touch(sessionId).catch(() => {});
  return parsed;
}

/**
 * Open a terminal pane on a live session (the `launch-terminal` verb):
 * the ordinary row + the runtime frame, in `sshTerminalCreate`'s order (row,
 * token, launch, settle), and a refusal deletes the row it just wrote. The
 * ORDER IS LOAD-BEARING: `issueSubshellToken` stamps the key id onto the
 * subshell row it already expects to exist (the guard's forgery check reads
 * the row's `api_key_id`), so the row must be written first or the pane's own
 * token authenticates as nothing. The token plaintext is held ONLY in the
 * session (design §5: never transmitted); the pane env carries its id and the
 * callback socket instead of the token and the plane URL.
 */
export async function sessionLaunchTerminal(
  sessionId: string,
  userId: string,
  body: { cwd: string; cols?: number; rows?: number },
): Promise<{ subshellId: string }> {
  const session = requireOwnedSession(sessionId, userId);
  const id = randomUUID();
  const socket = tmuxSocketFor(id);
  const harness = getHarness("terminal");
  if (harness === undefined) throw new SshRuntimeRefusal(500, "the built-in terminal harness is not available");
  await subshellsRepo.create({
    id,
    userId,
    harnessId: "terminal",
    name: normalizeLabel(`SSH ${session.target.alias}`, 120),
    workingDir: body.cwd,
    presetId: null,
    nodeId: session.runtimeNodeId,
    tmuxSocket: socket,
    status: "running",
    alive: 1,
    startedAt: new Date().toISOString(),
    notify: 1,
    crossAgent: 0,
  });
  let token: string;
  try {
    token = await issueSubshellToken(id, userId);
  } catch (err) {
    // the row must not exist without its minted key (the same posture as the
    // failed launch below: the pane never existed)
    await subshellsRepo.delete(id).catch(() => {});
    throw err;
  }
  session.registerPane(id, token);
  const launcher = new RuntimeSessionLauncher(session);
  try {
    await launcher.launch({
      id,
      socket,
      harness,
      binary: "",
      cwd: body.cwd,
      preset: {
        name: "terminal",
        description: null,
        env: {},
        flags: [],
        settings: null,
        configIsolation: false,
      },
      subshellName: id,
      // The callback-socket contract (design §5): no token, no plane URL.
      subshellEnv: {
        SUBSHELL_ID: id,
        SUBSHELL_NAME: normalizeLabel(`SSH ${session.target.alias}`, 120),
        SUBSHELL_RUNTIME_CALLBACK_SOCK: session.callbackSockPath,
      },
    });
    // Geometry is a request after the spawn (the node-link's own ordering:
    // launch, then resize), and a refused fit must not fail a live pane.
    if (body.cols !== undefined && body.rows !== undefined) {
      await launcher.resize(socket, id, body.cols, body.rows).catch(() => {});
    }
  } catch (err) {
    // The row must not outlive the failed spawn (the create path's posture):
    // the pane never existed. The token it minted goes with it.
    session.unregisterPane(id);
    await revokeSubshellToken(id).catch(() => {});
    await subshellsRepo.delete(id).catch(() => {});
    if (err instanceof Error && /harness binary missing/.test(err.message)) {
      throw new SshRuntimeRefusal(409, err.message, "runtime_missing");
    }
    throw err;
  }
  await audit({
    actorUserId: userId,
    action: "ssh_runtime_session.pane_open",
    targetType: "subshell",
    targetId: id,
    metadataJson: JSON.stringify({ sessionId, runtimeNodeId: session.runtimeNodeId }),
  });
  return { subshellId: id };
}

/**
 * Close a session (the user's act, design §6's Close). Two frames, in order:
 * the `close` COMMAND reaches the runtime (graceful exit, final census - see
 * `SshRuntimeSession.close`), and `ssh_session_close` reaches the BROKER so
 * the supervisor group-kills the SSH child and records `closed` on disk
 * (either half may find its target already gone - a runtime that exited
 * cleanly takes the child with it; a runtime that ignored the command is why
 * the broker's kill exists). Panes on the destination keep running.
 */
export async function closeSession(sessionId: string, userId: string): Promise<void> {
  const session = requireOwnedSession(sessionId, userId);
  await session.close();
  await closeBestEffort(session.connectingNodeId, sessionId);
  await audit({
    actorUserId: userId,
    action: "ssh_runtime_session.close",
    targetType: "ssh_runtime_session",
    targetId: sessionId,
    metadataJson: JSON.stringify({ connectingNodeId: session.connectingNodeId }),
  });
}

/** A session view for the routes; owner-only (foreign id reads 404 like every invisible resource). */
export async function getSessionView(sessionId: string, userId: string): Promise<SshRuntimeSessionView> {
  const row = await sessionsRepo.findById(sessionId);
  if (!row || row.ownerUserId !== userId) throw new SshRuntimeRefusal(404, "session not found");
  return viewOfRow(row);
}

/** The owner's sessions, newest first (the recent-destinations history; design §6's "rows history"). */
export async function listSessions(userId: string): Promise<SshRuntimeSessionView[]> {
  return (await sessionsRepo.listByOwner(userId)).map(viewOfRow);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The live session for an owner, or the 404 reading (foreign ids never distinguish "gone" from "never was"). */
function requireOwnedSession(sessionId: string, userId: string): SshRuntimeSession {
  const session = getSession(sessionId);
  if (!session || session.ownerId !== userId) {
    throw new SshRuntimeRefusal(404, "session not found");
  }
  return session;
}

/** Undo the DB rows an open attempt wrote, when the attempt itself failed (the node-side supervisor's `#dropRecord`, plane-side). */
async function unrollOpening(sessionId: string, runtimeNodeId: string, cause: unknown): Promise<void> {
  if (cause instanceof Error) logger.debug(`ssh-runtime open ${sessionId.slice(0, 8)} failed: ${cause.message}`);
  await sessionsRepo.settle(sessionId, "lost", null).catch(() => {});
  await nodesRepo.setStatus(runtimeNodeId, "offline").catch(() => {});
  await nodesRepo.deleteById(runtimeNodeId).catch(() => {});
  await sessionsRepoDeleteRow(sessionId).catch(() => {});
}

/** The full row delete (history rows OUTLIVE lost sessions, but a never-spawned opening must leave nothing). */
async function sessionsRepoDeleteRow(sessionId: string): Promise<void> {
  await db.deleteFrom("sshRuntimeSessions").where("id", "=", sessionId).execute();
}

/**
 * Ask the node to forget a session - best effort, every answer swallowed.
 * Two callers, same shape: the protocol-mismatch unroll (the child must not
 * linger for a runtime that will never speak) and the user close (the
 * supervisor's group-kill; the runtime may have exited already, in which case
 * the answer is `session_unknown` and there is nothing to kill).
 */
async function closeBestEffort(connectingNodeId: string, sessionId: string): Promise<void> {
  try {
    await sendCommand(connectingNodeId, { type: "ssh_session_close", ref: sessionId }, { timeoutMs: 10_000 });
  } catch {
    // the node's own boot reconcile will read its `lost` records; this is hygiene, not correctness
  }
}

/** Map the brokered-open failure onto the named refusal (equality on `detail`, the house rule). */
function mapOpenError(err: unknown): SshRuntimeRefusal {
  if (err instanceof Error && "detail" in err && typeof err.detail === "string") {
    const detail = err.detail;
    if (detail === "runtime_missing") return new SshRuntimeRefusal(409, detail, "runtime_missing");
    if (detail === "session_quota")
      return new SshRuntimeRefusal(409, "the connecting node carries its share of open sessions", "session_quota");
    if (detail === "session_protocol") return new SshRuntimeRefusal(409, detail, "session_protocol");
    if (detail === "run_conflict")
      return new SshRuntimeRefusal(409, "a session ref collided; nothing was spawned twice", "run_conflict");
    if (detail === "host_key_unknown" || detail === "host_key_changed" || detail === "host_key_revoked") {
      return new SshRuntimeRefusal(409, `host trust: ${detail}`, detail as SshErrorCode);
    }
    if (detail === "auth_mode_unsupported" || detail === "key_unavailable") {
      return new SshRuntimeRefusal(409, detail, detail as SshErrorCode);
    }
    return new SshRuntimeRefusal(409, `the destination refused the session: ${detail}`, null);
  }
  return new SshRuntimeRefusal(502, err instanceof Error ? err.message : "the brokered session failed");
}

async function viewOf(id: string): Promise<SshRuntimeSessionView> {
  const row = await sessionsRepo.findById(id);
  if (!row) throw new SshRuntimeRefusal(500, "session row vanished");
  return viewOfRow(row);
}

function viewOfRow(
  row: Awaited<ReturnType<SshRuntimeSessionsRepository["findById"]>> extends infer R ? NonNullable<R> : never,
): SshRuntimeSessionView {
  return {
    id: row.id,
    connectingNodeId: row.connectingNodeId,
    runtimeNodeId: row.runtimeNodeId,
    alias: row.alias,
    host: row.host,
    port: row.port,
    user: row.user,
    status: row.status,
    hello: helloFromJson(row.helloJson),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    closedAt: row.closedAt,
  };
}

function helloFromJson(json: string | null): SshRuntimeHelloWire | null {
  if (json === null) return null;
  try {
    return parseSshRuntimeHello(JSON.parse(json));
  } catch {
    return null;
  }
}
