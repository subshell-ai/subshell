import { randomUUID } from "node:crypto";
import { getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import { type NodeFsLsResult, normalizeLabel, parseNodeFsLsResult } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { audit } from "@/services/audit.js";
import { issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";
import { RuntimeSessionLauncher } from "./runtime-session-launcher.js";
import type { SshRuntimeSession } from "./session.js";
import { getSession } from "./session-registry.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";
import { closeBestEffort, SshRuntimeRefusal, type SshRuntimeSessionView, viewOfRow } from "./sessions.service.js";

/**
 * The lifecycle half of the runtime-session service (design 2026-10-05 §4):
 * the verbs that act ON a live session - browse its destination, launch its
 * terminal pane, close it - and the owner's history reads. The open flow
 * (gate, rows, broker, register) lives in `sessions.service.ts`, the settle
 * writes in `session-settle.ts`; this file reaches a live session only
 * through `requireOwnedSession`, so "not yours" and "never was" stay the
 * same 404 reading everywhere.
 *
 * The ORDER rules that outlive the move: a launch writes row -> token ->
 * frame (the guard's forgery check reads the row's `api_key_id`, so the row
 * exists first) and a failed launch unrolls every write; a close sends the
 * framed `close` before the broker's `ssh_session_close` and settles
 * regardless of the runtime's answer (design §6).
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const subshellsRepo = new SubshellsRepository(db);

/** The live session for an owner, or the 404 reading (foreign ids never distinguish "gone" from "never was"). */
function requireOwnedSession(sessionId: string, userId: string): SshRuntimeSession {
  const session = getSession(sessionId);
  if (!session || session.ownerId !== userId) {
    throw new SshRuntimeRefusal(404, "session not found");
  }
  return session;
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
