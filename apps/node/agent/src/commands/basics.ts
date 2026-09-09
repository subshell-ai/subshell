import { realpath, stat, unlink } from "node:fs/promises";
import { getHarness, tmuxSocketFor } from "@internal/pane-runtime";
import { type JsonValue, NODE_MAX_FRAME_BYTES, type NodeProbeEntry } from "@internal/subshell-protocol";
import { writeAllowedDirs } from "../allowed-dirs.js";
import { buildInventoryEvent } from "../inventory.js";
import { pathAllowed } from "../path-policy.js";
import { isSubshellId } from "../subshell-meta.js";
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
 * Resolve the tmux socket for a wire-supplied subshell id (spec §6.3): the
 * socket recorded at launch wins — `meta.get` answers from the store's
 * record mirror after the first lookup, so per-keystroke commands never
 * re-read the file — and `tmuxSocketFor` is the orphan fallback. The id is
 * format-checked BEFORE any store touch — the store throws on a malformed
 * id, and the message the dispatcher answers must be exactly
 * `invalid subshell id`. Shared with prompt.ts (the settle loop captures and
 * types on the same socket the other pane executors use).
 */
export async function resolveSocket(ctx: CommandContext, subshellId: string): Promise<string> {
  if (!isSubshellId(subshellId)) throw new Error("invalid subshell id");
  return (await ctx.meta.get(subshellId))?.socket ?? tmuxSocketFor(subshellId);
}

/**
 * `terminate` (spec §7): STRICT `kill-session` — a tmux refusal is the answer
 * (`{ok:false}`), mirroring `LocalLauncher.terminate`. The subshell's exit
 * watcher is stopped FIRST: a deliberate kill must not double-report a death
 * the control plane just ordered (Task 4's report.ts owns the watchers).
 */
export async function execTerminate(ctx: CommandContext, cmd: Cmd<"terminate">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.subshellId);
  stopWatcher(ctx, cmd.subshellId);
  ctx.tmux.run(["-L", socket, "kill-session", "-t", cmd.subshellId], {});
  return { ok: true };
}

/**
 * `kill` (spec §7): best-effort `kill-session` — "already gone" is success,
 * mirroring `LocalLauncher.killSubshell` (the restart/terminate sweeps call it
 * on panes that may have died on their own). Like `terminate`, stops the exit
 * watcher before killing so the death never arrives as a surprise `exit`
 * event.
 */
export async function execKill(ctx: CommandContext, cmd: Cmd<"kill">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.subshellId);
  stopWatcher(ctx, cmd.subshellId);
  try {
    ctx.tmux.killSubshell(socket, cmd.subshellId);
  } catch {
    // already gone — the pane is dead, which is all `kill` promises
  }
  return { ok: true };
}

/** `input` (spec §7): raw keystrokes into the pane, byte-for-byte (`send-keys -l`). */
export async function execInput(ctx: CommandContext, cmd: Cmd<"input">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.subshellId);
  ctx.tmux.sendInput(socket, cmd.subshellId, cmd.data);
  return { ok: true };
}

/** `resize` (spec §7): fit the pane to the viewing terminal's geometry. */
export async function execResize(ctx: CommandContext, cmd: Cmd<"resize">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.subshellId);
  ctx.tmux.resizeWindow(socket, cmd.subshellId, cmd.cols, cmd.rows);
  return { ok: true };
}

/**
 * `pane_size` (protocol v4): the pane's REAL grid, or null when it is gone.
 *
 * The remote twin of the control plane's own readback. It exists because a
 * pane serves several viewers now and is sized to the smallest of them, so a
 * client left to size itself renders rows the pane does not have — and until
 * this command existed the control plane could only announce the size it had
 * ASKED for. Null is a legal answer (a vanished pane), distinct from an
 * error; the caller announces nothing rather than a guess for either.
 */
export async function execPaneSize(ctx: CommandContext, cmd: Cmd<"pane_size">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.subshellId);
  return { ok: true, data: ctx.tmux.paneSize(socket, cmd.subshellId) };
}

/** `capture` (spec §6.3): the pane's screen as a bare string (contract: `parseNodeCaptureResult`). Optional `lines` prepends reflowed history rows (attach replay). */
export async function execCapture(ctx: CommandContext, cmd: Cmd<"capture">): Promise<CommandResult> {
  const socket = await resolveSocket(ctx, cmd.subshellId);
  return { ok: true, data: ctx.tmux.capturePane(socket, cmd.subshellId, cmd.lines) };
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
  for (const subshellId of cmd.subshellIds) {
    if (!isSubshellId(subshellId)) throw new Error("invalid subshell id");
  }
  const entries: NodeProbeEntry[] = [];
  for (const subshellId of cmd.subshellIds) {
    const socket = tmuxSocketFor(subshellId); // same derivation the launcher uses — no stored state needed
    if (!ctx.tmux.hasSubshell(socket, subshellId)) {
      entries.push({ subshellId, alive: false, exitCode: ctx.tmux.paneExitCode(socket, subshellId) });
      continue;
    }
    const pane = ctx.tmux.paneTitle(socket, subshellId);
    const entry: NodeProbeEntry = { subshellId, alive: true, exitCode: null };
    if (pane) {
      entry.title = pane.title;
      entry.command = pane.command;
    }
    try {
      entry.capture = ctx.tmux.capturePane(socket, subshellId);
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
 * machine (identical `@internal/pane-runtime` code as the local path). Unknown
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
  // NOT gated by the directory allowlist, deliberately — the same rule `fs_ls`
  // follows: a PROBE is not a launch.
  //
  // It was gated, on the argument that the pre-launch check should answer the
  // way `launch` will. That was wrong twice over. The control plane already
  // refuses a disallowed cwd before it ever probes (`assertDirAllowed`, with a
  // message naming the permitted directories), and `execLaunch` remains this
  // node's own independent gate — so nothing was gained. What it cost was
  // real: the control plane RESOLVES each new rule by calling `stat_dir` here,
  // so once a node had one rule, adding a second one outside it was refused,
  // the resolution silently fell back to the raw string, and the rule never
  // matched the realpath'd candidate. The "second rule unaddable" trap,
  // resurfacing one layer down.
  return { ok: true, data: { path: resolved, isDirectory: true } };
}

/**
 * `set_allowed_dirs` (protocol v5): replace this node's persisted directory
 * allowlist and answer with what was stored.
 *
 * The control plane pushes on every owner edit and again after each `ready`,
 * so this is both the update and the reconciliation path — a node that was
 * offline for an edit learns the current rules on reconnect. Idempotent by
 * construction: the file is replaced wholesale.
 */
export async function execSetAllowedDirs(ctx: CommandContext, cmd: Cmd<"set_allowed_dirs">): Promise<CommandResult> {
  try {
    const stored = writeAllowedDirs(ctx.config.dataDir, cmd.dirs);
    return { ok: true, data: { dirs: stored } };
  } catch (err) {
    // A failed write leaves the PREVIOUS rules in force (temp + rename never
    // half-applies), which is the safe direction — the node keeps enforcing
    // what it last agreed to rather than falling open.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `remove_paths` (spec §7): delete cleanup (pane log + mcp config). ALL paths
 * are policy-checked against <dataDir> + every tracked subshell's launch cwd
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
    ctx.ws.send(await buildInventoryEvent(ctx.nowMs(), undefined, ctx.config.dataDir));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `inventory: ${err instanceof Error ? err.message : String(err)}` };
  }
}
