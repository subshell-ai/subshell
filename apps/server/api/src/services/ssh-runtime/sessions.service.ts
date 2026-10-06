import { randomUUID } from "node:crypto";
import {
  normalizeLabel,
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
import { logger } from "@/utils/logger.js";
import { SshRuntimeSession } from "./session.js";
import { registerSession, sessionHooks } from "./session-registry.js";
import { installSessionSettlers } from "./session-settle.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";

/**
 * The control-plane half of SSH runtime sessions (design 2026-10-05 §4):
 * open a brokered session through a node the caller OWNS and keep its row.
 * This is the LAUNCH PATH DECISION the slice was asked to make, recorded in
 * code: the hidden `nodes` row (kind `runtime`) plus the registry branch in
 * `launcher-registry.ts` is what the pane plumbing needs, and it cost one
 * column-value, one insert, and a three-line registry branch - nothing
 * heavier, and the alternative (session rows carrying node facts ad hoc)
 * would have forked every pane surface instead of reusing it.
 *
 * One concern per file: this module is the OPEN door (gate, rows, broker,
 * register) and the shared refusal/view surface the sibling modules read
 * through it - the in-session lifecycle (launch/close/list/view/browse) lives
 * in `sessions-lifecycle.ts`, and the settling (lost/closed/exit/census, and
 * the boot sweep that marks rows lost when this process restarts) lives in
 * `session-settle.ts`; this module installs those handlers at load, before
 * any session can exist.
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

/** A refusal the routes map to a named API error: the transport/eligibility facts are never guessed at the handler. */
export class SshRuntimeRefusal extends Error {
  readonly status: number;
  /**
   * The named code when there is one (frozen `SshErrorCode`, `session_unknown`,
   * or `detect_unsupported` - the task-25 capability refusal the harnesses
   * verbs answer 409 with when the destination runtime predates `"detect"`).
   */
  readonly code: SshErrorCode | "session_unknown" | "detect_unsupported" | null;
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

/* ------------------------------------------------------------------ */
/* open-flow helpers                                                   */
/* ------------------------------------------------------------------ */

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
 * linger for a runtime that will never speak) and the user close in
 * `sessions-lifecycle.ts` (the supervisor's group-kill; the runtime may have
 * exited already, in which case the answer is `session_unknown` and there is
 * nothing to kill).
 */
export async function closeBestEffort(connectingNodeId: string, sessionId: string): Promise<void> {
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

/** The row -> view projection (the DB facts, the stored hello re-parsed or null). @internal shared with `sessions-lifecycle.ts` */
export function viewOfRow(
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

/* ------------------------------------------------------------------ */
/* pane identity (the terminal page's trusted line, design §7)          */
/* ------------------------------------------------------------------ */

/** What the pane page renders as the trusted identity line, from the rows only. */
export interface SshPaneIdentityView {
  sessionId: string;
  status: SshRuntimeSessionStatus;
  alias: string;
  host: string;
  port: number;
  user: string | null;
  /** The broker's machine NAME (null when that node row has since been deleted). */
  connectingNodeName: string | null;
}

/**
 * Resolve a pane to the SSH session that launched it, for the trusted
 * identity line. The pane's ordinary row names its node; a runtime-session
 * pane's `nodeId` IS the session's hidden runtime node, so one lookup joins
 * the two, and the connecting machine's name joins the three. Every shape of
 * "this pane did not come through a session of yours" (an ordinary pane, a
 * foreign pane, a foreign session, a deleted row) answers the same 404, the
 * subshells' non-enumerating convention: the caller cannot tell which, and
 * the line simply does not render.
 */
export async function getPaneIdentityView(subshellId: string, userId: string): Promise<SshPaneIdentityView> {
  // The PANE's own ownership axis first (the subshells' convention: a foreign
  // pane is invisible, 404 - its identity line is not the session owner's to
  // read either); then the session row's owner, which is belt-and-braces on
  // the per-session runtime node id but states the rule where a reviewer can
  // see it.
  const pane = await new SubshellsRepository(db).findById(subshellId);
  if (pane === undefined || pane.userId !== userId) throw new SshRuntimeRefusal(404, "session not found");
  const session = await db
    .selectFrom("sshRuntimeSessions")
    .selectAll()
    .where("runtimeNodeId", "=", pane.nodeId)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  if (session === undefined || session.ownerUserId !== userId) throw new SshRuntimeRefusal(404, "session not found");
  const connecting = session.connectingNodeId ? await nodesRepo.findById(session.connectingNodeId) : undefined;
  return {
    sessionId: session.id,
    status: session.status,
    alias: session.alias,
    host: session.host,
    port: session.port,
    user: session.user,
    connectingNodeName: connecting?.name ?? null,
  };
}
