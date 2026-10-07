import { randomUUID } from "node:crypto";
import { getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import { type NodeFsLsResult, normalizeLabel, parseNodeFsLsResult } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { audit } from "@/services/audit.js";
import { publishLive } from "@/services/live-bus.js";
import { lockdownEnabled } from "@/services/lockdown.js";
import { nodeSelfInvoke, planRemoteSubshellMcp } from "@/services/mcp-launch.js";
import { EMPTY_PRESET, parsePreset } from "@/services/preset-definition.js";
import { PROMPT_POLL_MS, PROMPT_SETTLE_TIMEOUT_MS } from "@/services/subshell-manager.service.js";
import { issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";
import { resolveDestinationDir } from "./launch-dir.js";
import { RuntimeSessionLauncher } from "./runtime-session-launcher.js";
import { RUNTIME_PANE_BASE_URL, type SshRuntimeSession } from "./session.js";
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
const presetsRepo = new PresetsRepository(db);

/**
 * The live session for an owner, or the 404 reading (foreign ids never
 * distinguish "gone" from "never was"). Exported for `harness-detect.ts` (the
 * harnesses verbs share the exact door: same owner gate, same refusal).
 */
export function requireOwnedSession(sessionId: string, userId: string): SshRuntimeSession {
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
  if (await lockdownEnabled(db))
    throw new SshRuntimeRefusal(409, "This instance is in lockdown. No new subshells can be started.");
  const harness = getHarness("terminal");
  if (harness === undefined) throw new SshRuntimeRefusal(500, "the built-in terminal harness is not available");
  // Stat-verified BEFORE the row (F3, design §7): a missing destination
  // directory refuses by name instead of launching into the shell's fallback.
  // It is the last cheap check before the first write - the guard refusals
  // stay frameless, and the stat gate precedes the row/token/frame order.
  const cwd = await resolveDestinationDir(session, body.cwd);
  const id = randomUUID();
  const socket = tmuxSocketFor(id);
  await subshellsRepo.create({
    id,
    userId,
    harnessId: "terminal",
    name: normalizeLabel(`SSH ${session.target.alias}`, 120),
    workingDir: cwd,
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
      cwd,
      preset: {
        name: "terminal",
        description: null,
        env: {},
        flags: [],
        settings: null,
        configIsolation: false,
      },
      subshellName: id,
      // The callback-socket contract (design §5): no token, no plane URL -
      // this pane's OWN door (task 25: per-connection attribution on a
      // multi-pane session), and the never-resolves sentinel base URL so any
      // code path that bypasses the door's transport dies at DNS rather than
      // reaching a same-address server on the destination.
      subshellEnv: {
        SUBSHELL_ID: id,
        SUBSHELL_NAME: normalizeLabel(`SSH ${session.target.alias}`, 120),
        SUBSHELL_RUNTIME_CALLBACK_SOCK: session.paneCallbackSockPath(id),
        SUBSHELL_BASE_URL: RUNTIME_PANE_BASE_URL,
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
 * Open a HARNESS pane on a live session (the `launch-harness` verb, the mount
 * for the detect wave's seam): the same row -> token -> frame order as
 * {@link sessionLaunchTerminal}, with the ordinary LaunchPlan composed here -
 * harness resolution, optional preset (owner-checked, harness-matched), the
 * MCP registration and the reporter hook command baked against the runtime's
 * HELLO facts (`planRemoteSubshellMcp`/`nodeSelfInvoke` on `hello.dataDir` +
 * `hello.selfInvoke`: the destination writes its own config file at its own
 * path, and hooks re-enter the destination's own binary), and a fresh
 * harness conversation id for resume-capable harnesses (the manager's
 * start-mode allocation; a runtime pane is never resumed - the restart door
 * seals runtime rows, so this id's only later reader is the census).
 * `RuntimeSessionLauncher.launch`'s preset parity (mcp block + harnessSession
 * + argv) carries it all to the frame.
 *
 * The HARD invariant stands unchanged (design §5): the pane env carries the
 * id, the display name, the pane's OWN callback door, the destination data
 * dir and the never-resolves sentinel - never the minted token, never the
 * plane URL. The token lives only in `#paneTokens`; every callback executes
 * plane-side as the pane. Pinned by the credential-scan test on this path.
 *
 * @throws SshRuntimeRefusal 404 (foreign/absent session or preset), 409
 *         (unknown harness, harness/preset mismatch, harness not installed on
 *         the destination - the terminal verb's `runtime_missing` family)
 */
export async function sessionLaunchHarness(
  sessionId: string,
  userId: string,
  body: { harnessId: string; presetId?: string | null; cwd: string; cols?: number; rows?: number; prompt?: string },
): Promise<{ subshellId: string; promptDelivered?: boolean }> {
  const session = requireOwnedSession(sessionId, userId);
  if (await lockdownEnabled(db))
    throw new SshRuntimeRefusal(409, "This instance is in lockdown. No new subshells can be started.");
  const harness = getHarness(body.harnessId);
  if (harness === undefined) throw new SshRuntimeRefusal(409, `unknown harness: ${body.harnessId}`);
  const presetRow = body.presetId ? await presetsRepo.findById(body.presetId) : undefined;
  if (body.presetId && (!presetRow || presetRow.userId !== userId)) {
    // A foreign preset and an absent one answer the same 404 (the invisible-
    // resource convention this whole surface obeys; the manager's create door
    // states the same rule for ordinary rows).
    throw new SshRuntimeRefusal(404, "preset not found");
  }
  if (presetRow && presetRow.harnessId !== harness.id) {
    throw new SshRuntimeRefusal(409, "preset harness mismatch");
  }
  const preset = presetRow ? parsePreset(presetRow) : EMPTY_PRESET;
  // Stat-verified before any plane write (the terminal verb's rule, F3): the
  // last check before the row/token/frame order begins, and no guard refusal
  // above it ever dials the destination.
  const cwd = await resolveDestinationDir(session, body.cwd);
  // Fresh conversation id for resume-capable harnesses, start mode (module
  // doc: never resumed on this surface); pinned on the row at insert, the
  // manager's own ordering, so the census and any later lineage read see it.
  const harnessSession = harness.resume
    ? { id: harness.resume.allocateHarnessSessionId(), mode: "start" as const }
    : undefined;
  const id = randomUUID();
  const socket = tmuxSocketFor(id);
  const paneName = normalizeLabel(`SSH ${session.target.alias}`, 120);
  await subshellsRepo.create({
    id,
    userId,
    harnessId: harness.id,
    name: paneName,
    workingDir: cwd,
    presetId: presetRow?.id ?? null,
    nodeId: session.runtimeNodeId,
    tmuxSocket: socket,
    status: "running",
    alive: 1,
    startedAt: new Date().toISOString(),
    notify: 1,
    crossAgent: 0,
    harnessSessionId: harnessSession?.id ?? null,
  });
  let token: string;
  try {
    token = await issueSubshellToken(id, userId);
  } catch (err) {
    await subshellsRepo.delete(id).catch(() => {});
    throw err;
  }
  session.registerPane(id, token);
  const launcher = new RuntimeSessionLauncher(session);
  try {
    // The registration and the hook command compose against the HELLO facts,
    // not the node registry: a runtime's dataDir and self-invoke come from its
    // own hello (task 25's field), exactly as an agent's come from its ready
    // frame. Nothing here touches disk on the plane. They run INSIDE the
    // guarded scope (M-2): `planRemoteSubshellMcp` executes the harness
    // plugin's `mcpRegistration` dialect, and a throwing dialect must unroll
    // the row, the token, and the registration exactly like a failed send -
    // never orphan them as a pane that can never launch.
    const planned = planRemoteSubshellMcp(harness, id, {
      dataDir: session.hello.dataDir,
      selfInvoke: session.hello.selfInvoke,
    });
    const reporter = nodeSelfInvoke({ selfInvoke: session.hello.selfInvoke }, "report");
    await launcher.launch({
      id,
      socket,
      harness,
      binary: "",
      cwd,
      preset,
      // The destination tmux session name is the pane id (the terminal verb's
      // rule, and the reconcile's match key: the census reports destination
      // session names and the plane matches them to row ids).
      subshellName: id,
      // Door + sentinel + destination data dir, no token, no plane URL -
      // design §5's bake, identical to the terminal verb's plus the data dir
      // the `subshell mcp` child persists its keypairs under.
      subshellEnv: {
        SUBSHELL_ID: id,
        SUBSHELL_NAME: paneName,
        SUBSHELL_RUNTIME_CALLBACK_SOCK: session.paneCallbackSockPath(id),
        SUBSHELL_DATA_DIR: session.hello.dataDir,
        SUBSHELL_BASE_URL: RUNTIME_PANE_BASE_URL,
      },
      mcp: planned?.reg,
      mcpConfigPath: planned?.configPath,
      harnessSession,
      reporter,
    });
    if (body.cols !== undefined && body.rows !== undefined) {
      await launcher.resize(socket, id, body.cols, body.rows).catch(() => {});
    }
  } catch (err) {
    session.unregisterPane(id);
    await revokeSubshellToken(id).catch(() => {});
    await subshellsRepo.delete(id).catch(() => {});
    // The destination's own resolve ladder refused the harness binary: the
    // honest remedy is the HARNESS on the destination (the terminal verb
    // points at the Subshell binary; a named harness's missing binary is a
    // different install).
    if (err instanceof Error && /harness binary missing/.test(err.message)) {
      throw new SshRuntimeRefusal(409, `Harness "${harness.name}" is not installed on the destination.`);
    }
    throw err;
  }
  await audit({
    actorUserId: userId,
    action: "ssh_runtime_session.pane_open",
    targetType: "subshell",
    targetId: id,
    metadataJson: JSON.stringify({
      sessionId,
      runtimeNodeId: session.runtimeNodeId,
      harnessId: harness.id,
      ...(presetRow ? { presetId: presetRow.id } : {}),
    }),
  });
  publishLive({ kind: "subshell.changed", id });
  let promptDelivered = false;
  if (body.prompt?.trim()) {
    promptDelivered = await launcher
      .deliverPrompt(socket, id, body.prompt, PROMPT_SETTLE_TIMEOUT_MS, PROMPT_POLL_MS)
      .catch(() => false);
  }
  return { subshellId: id, promptDelivered };
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
