import { realpath, stat, unlink } from "node:fs/promises";
import { getHarness, tmuxSocketFor } from "@internal/harnesses";
import { type JsonValue, NODE_MAX_FRAME_BYTES, type NodeProbeEntry } from "@internal/session-protocol";
import { buildInventoryEvent } from "../inventory.js";
import { pathAllowed } from "../path-policy.js";
import { isSessionId } from "../session-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { stopWatcher } from "./report.js";

/**
 * The phase-2 basic command executors (spec 2026-08-31 §7). Every function
 * here is TOTAL: it returns a {@link CommandResult} or throws a plain Error
 * whose message is the answer — `dispatchCommand` wraps the switch once, so a
 * throw (including the meta store's bad-id throw) can never escape it.
 */

/**
 * Result budget for a `probe` answer: the frame cap minus headroom for the
 * envelope (`result` wrapper + ref) so a stuffed probe never trips the
 * daemon's outbound guard.
 */
export const PROBE_RESULT_BUDGET_BYTES = NODE_MAX_FRAME_BYTES - 64 * 1024;

/**
 * Resolve the tmux socket for a wire-supplied session id (spec §6.3): the
 * socket recorded at launch wins — `meta.get` answers from the store's
 * record mirror after the first lookup, so per-keystroke commands never
 * re-read the file — and `tmuxSocketFor` is the orphan fallback. The id is
 * format-checked BEFORE any store touch — the store throws on a malformed
 * id, and the message the dispatcher answers must be exactly
 * `invalid session id`. Shared with prompt.ts (the settle loop captures and
 * types on the same socket the other pane executors use).
 */
export async function resolveSocket(ctx: CommandContext, sessionId: string): Promise<string> {
  if (!isSessionId(sessionId)) throw new Error("invalid session id");
  return (await ctx.meta.get(sessionId))?.socket ?? tmuxSocketFor(sessionId);
}

/**
 * `terminate` (spec §7): STRICT `kill-session` — a tmux refusal is the answer
 * (`{ok:false}`), mirroring `LocalLauncher.terminate`. The session's exit
 * watcher is stopped FIRST: a deliberate kill must not double-report a death
 * the control plane just ordered (Task 4's report.ts owns the watchers).
 */
export async function execTerminate(ctx: CommandContext, cmd: Cmd<"terminate">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.sessionId);
  stopWatcher(ctx, cmd.sessionId);
  ctx.tmux.run(["-L", socket, "kill-session", "-t", cmd.sessionId], {});
  return { ok: true };
}

/**
 * `kill` (spec §7): best-effort `kill-session` — "already gone" is success,
 * mirroring `LocalLauncher.killSession` (the restart/terminate sweeps call it
 * on panes that may have died on their own). Like `terminate`, stops the exit
 * watcher before killing so the death never arrives as a surprise `exit`
 * event.
 */
export async function execKill(ctx: CommandContext, cmd: Cmd<"kill">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.sessionId);
  stopWatcher(ctx, cmd.sessionId);
  try {
    ctx.tmux.killSession(socket, cmd.sessionId);
  } catch {
    // already gone — the pane is dead, which is all `kill` promises
  }
  return { ok: true };
}

/** `input` (spec §7): raw keystrokes into the pane, byte-for-byte (`send-keys -l`). */
export async function execInput(ctx: CommandContext, cmd: Cmd<"input">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.sessionId);
  ctx.tmux.sendInput(socket, cmd.sessionId, cmd.data);
  return { ok: true };
}

/** `resize` (spec §7): fit the pane to the viewing terminal's geometry. */
export async function execResize(ctx: CommandContext, cmd: Cmd<"resize">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.sessionId);
  ctx.tmux.resizeWindow(socket, cmd.sessionId, cmd.cols, cmd.rows);
  return { ok: true };
}

/** `capture` (spec §6.3): the pane's screen as a bare string (contract: `parseNodeCaptureResult`). Optional `lines` prepends reflowed history rows (attach replay). */
export async function execCapture(ctx: CommandContext, cmd: Cmd<"capture">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.sessionId);
  return { ok: true, data: ctx.tmux.capturePane(socket, cmd.sessionId, cmd.lines) };
}

/**
 * `probe` (spec §6.3 reconcile): batched has-session + exit code + pane title
 * + an opportunistic screen capture for alive panes. Captures feed the
 * backend's preview cache, so when the whole answer would bust the frame
 * budget they are dropped in ONE rebuild — the liveness rows survive.
 */
export async function execProbe(ctx: CommandContext, cmd: Cmd<"probe">): Promise<CommandResult> {
  // Same id-format gate as resolveSocket (probe never touches the store, but
  // a hostile id must not reach tmux either): one bad id fails the batch.
  for (const sessionId of cmd.sessionIds) {
    if (!isSessionId(sessionId)) throw new Error("invalid session id");
  }
  const entries: NodeProbeEntry[] = [];
  for (const sessionId of cmd.sessionIds) {
    const socket = tmuxSocketFor(sessionId); // same derivation the launcher uses — no stored state needed
    if (!ctx.tmux.hasSession(socket, sessionId)) {
      entries.push({ sessionId, alive: false, exitCode: ctx.tmux.paneExitCode(socket, sessionId) });
      continue;
    }
    const pane = ctx.tmux.paneTitle(socket, sessionId);
    const entry: NodeProbeEntry = { sessionId, alive: true, exitCode: null };
    if (pane) {
      entry.title = pane.title;
      entry.command = pane.command;
    }
    try {
      entry.capture = ctx.tmux.capturePane(socket, sessionId);
    } catch {
      // raced death — the row still reports alive from the has-session above
    }
    entries.push(entry);
  }
  // Cap guard: captures are opportunistic (preview cache), never let them blow the frame.
  let data: NodeProbeEntry[] = entries;
  if (Buffer.byteLength(JSON.stringify(data)) > PROBE_RESULT_BUDGET_BYTES) {
    data = entries.map(({ capture: _capture, ...rest }) => rest);
  }
  // The entry shape is JSON-safe by construction (`node-results.ts` owns it and
  // says a parsed one is "safe to cast"); an interface simply cannot structurally
  // satisfy JsonValue's index signature, so the seam cast is the intended route.
  return { ok: true, data: data as unknown as JsonValue };
}

/**
 * `probe_resume` (spec §6.4): run the harness plugin's OWN resume probe on this
 * machine (identical `@internal/harnesses` code as the local path). Unknown
 * harness → failure; a harness without the capability can never resume.
 */
export async function execProbeResume(_ctx: CommandContext, cmd: Cmd<"probe_resume">): Promise<CommandResult> {
  const harness = getHarness(cmd.harnessId);
  if (!harness) return { ok: false, error: "unknown harness" };
  const canResume = harness.resume ? harness.resume.canResume(cmd.harnessSessionId, cmd.cwd) : false;
  return { ok: true, data: { canResume } };
}

/**
 * `stat_dir` (spec §6.4): `validateWorkingDir` on the node's filesystem —
 * deliberately OUTSIDE the path policy (probing a user-typed dir is the
 * feature). Success answers the realpath + `isDirectory: true`; a missing
 * path or a non-directory answers `ENOENT:`/`ENOTDIR:` with the raw path.
 */
export async function execStatDir(_ctx: CommandContext, cmd: Cmd<"stat_dir">): Promise<CommandResult> {
  let resolved: string;
  try {
    resolved = await realpath(cmd.path);
  } catch {
    return { ok: false, error: `ENOENT: ${cmd.path}` };
  }
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(resolved);
  } catch {
    return { ok: false, error: `ENOENT: ${cmd.path}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `ENOTDIR: ${cmd.path}` };
  return { ok: true, data: { path: resolved, isDirectory: true } };
}

/**
 * `remove_paths` (spec §7): delete cleanup (pane log + mcp config). ALL paths
 * are policy-checked against <dataDir> + every tracked session's launch cwd
 * BEFORE any deletion — one refused path refuses the whole batch
 * (`path refused: <path>`), so a hostile entry can never ride along with a
 * legitimate one. Absent files count not toward `removed`.
 */
export async function execRemovePaths(ctx: CommandContext, cmd: Cmd<"remove_paths">): Promise<CommandResult> {
  const roots = [ctx.config.dataDir, ...(await ctx.meta.list()).map((m) => m.cwd)];
  for (const p of cmd.paths) {
    if (!(await pathAllowed(p, roots))) return { ok: false, error: `path refused: ${p}` };
  }
  let removed = 0;
  for (const p of cmd.paths) {
    try {
      await unlink(p);
      removed += 1;
    } catch {
      // already gone — not an error, just not a removal
    }
  }
  return { ok: true, data: { removed } };
}

/**
 * `inventory` (spec §3.3/§7): EVENT FIRST (the server persists from it),
 * result second — moved verbatim from the phase-1 daemon dispatch, with the
 * send routed through `ctx.ws`.
 */
export async function execInventory(ctx: CommandContext): Promise<CommandResult> {
  try {
    ctx.ws.send(await buildInventoryEvent(ctx.nowMs()));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `inventory: ${err instanceof Error ? err.message : String(err)}` };
  }
}
