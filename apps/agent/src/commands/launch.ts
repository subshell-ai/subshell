import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildHarnessCommand, getHarness, type McpRegistration, type ProfileDefinition } from "@internal/harnesses";
import { enforceMode } from "../fs-mode.js";
import { log } from "../log.js";
import { pathAllowed, realpathRoots } from "../path-policy.js";
import { isSessionId } from "../session-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { startExitWatcher } from "./report.js";

/**
 * The `launch` executor (spec 2026-08-31 §6.4/§7) — the agent-side twin of
 * `LocalLauncher.launch`. Byte-parity rule: local and remote panes are
 * assembled by the SAME `buildHarnessCommand` (curatedEnv ⊕ subshellEnv ⊕
 * profile.env ⊕ mcp.env, plugin argv, resume pin), so the wire carries only
 * the INPUTS and the plugin code runs on the machine the pane lives on.
 */

/**
 * Start one harness session on this node.
 *
 * Step order is contractual (interfaces, brief §Task 4): id gate → harness →
 * binary → MCP file (policy-gated) → meta record → pane argv assembly →
 * `newSession` (rollback on throw) → log attach (strict by default;
 * `bestEffortLog` downgrades the whole attach region) → optional resize
 * (cosmetic) → exit watcher. A strict log-attach throw PROPAGATES (the
 * dispatcher answers `{ok:false}`) exactly like `LocalLauncher.launch`
 * throwing from `pipePane` — but the live pane's meta record STAYS (parity
 * with the local throw path; cleanup is the control plane's).
 *
 * @param ctx - the per-daemon execution context (config, tmux, meta, ws seam)
 * @param cmd - the verified `launch` command
 * @returns `{ok:true}` on acceptance; `{ok:false, error}` on a refused input;
 * infrastructure throws surface through `dispatchCommand` as `{ok:false}`.
 */
export async function execLaunch(ctx: CommandContext, cmd: Cmd<"launch">): Promise<CommandResult> {
  // Id gate FIRST (same rule as resolveSocket): the meta store throws on a
  // malformed id and every path below interpolates it — never touch harness,
  // fs, or tmux with an id the control plane could not have minted.
  if (!isSessionId(cmd.sessionId)) return { ok: false, error: "invalid session id" };

  const harness = getHarness(cmd.harnessId);
  if (!harness) return { ok: false, error: `unknown harness: ${cmd.harnessId}` };
  const binary = await harness.findBinary();
  if (!binary) {
    // Message CLASS contract: the backend maps `/binary missing/i` on a launch
    // failure to an inventory refresh (spec §6.2) — keep the prefix stable.
    return { ok: false, error: `harness binary missing: ${cmd.harnessId}` };
  }

  // (3) MCP registration. The frozen wire carries only {path, fileContent};
  // the plugin dialect's argv (`--mcp-config …` for claude) and env
  // (opencode's OPENCODE_CONFIG) come from McpRegistration.args/.env — which
  // never ride the wire. Fix (resolved design): the AGENT re-runs the plugin
  // locally, `harness.mcpRegistration({command: process.execPath, args:["mcp"]}, path)`,
  // the exact function the control plane runs host-side (mcp-launch.ts), so
  // the dialect is byte-identical ON THE MACHINE THE PANE LIVES ON. The wire's
  // fileContent was computed against `ready.executablePath` (Task 1); when it
  // disagrees with the locally regenerated content the wire is stale (an old
  // ready, a moved binary) — one warn line and the LOCAL content wins, while
  // `reg`'s args+env are ALWAYS the agent's own.
  let reg: McpRegistration | undefined;
  if (cmd.mcp) {
    if (!(await pathAllowed(cmd.mcp.path, await realpathRoots([ctx.config.dataDir])))) {
      return { ok: false, error: "mcp path refused" };
    }
    reg = harness.mcpRegistration?.({ command: process.execPath, args: ["mcp"] }, cmd.mcp.path);
    let content = cmd.mcp.fileContent;
    if (reg && content !== reg.fileContent) {
      log(
        `mcp config drift for session ${cmd.sessionId}: wire content != agent-local dialect — using the local content`,
      );
      content = reg.fileContent;
    }
    // Canonical location is <dataDir>/mcp/<id>.json (session-meta mcpPath twin);
    // mkdir the parent whatever the (already policy-passed) path names.
    const dir = dirname(cmd.mcp.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(cmd.mcp.path, content, { mode: 0o600 });
    await enforceMode(cmd.mcp.path, 0o600); // Task-2 re-tightening: umask cannot leak bits here
  }

  // (4) Record meta FIRST: path policy + socket lookup must see the cwd even
  // while later steps are in flight (and the rollback below has something to
  // roll back). `record` creates <dataDir>/sessions with 0700.
  await ctx.meta.record({
    sessionId: cmd.sessionId,
    cwd: cmd.cwd,
    socket: cmd.socket,
    harnessId: cmd.harnessId,
    name: cmd.sessionName,
    startedAt: new Date(ctx.nowMs()).toISOString(),
  });

  // (5) §6.4 assembly + (6) spawn. The wire profile is the structural mirror
  // (`ProfileDefinitionWire`) — same field names, the frame validator already
  // ran — so the cast is the intended decode, exactly where the brief pins it.
  const profile = cmd.profile as unknown as ProfileDefinition;
  try {
    const paneCmd = buildHarnessCommand(
      harness,
      binary,
      cmd.cwd,
      profile,
      cmd.sessionName,
      cmd.subshellEnv,
      reg,
      cmd.harnessSession,
    );
    ctx.tmux.newSession(cmd.socket, cmd.sessionId, cmd.cwd, paneCmd);
  } catch (err) {
    await ctx.meta.forget(cmd.sessionId); // nothing spawned — no orphan root for the policy
    throw err; // dispatcher answers {ok:false}; mirrors LocalLauncher's throw path
  }

  // (7) Log attach — the pane-log dir ensure + pipe-pane pair, ONE guard so
  // the strict and best-effort paths can never drift (same single-home rule as
  // LocalLauncher's `#ensureLogDir`).
  const logFile = ctx.meta.logPath(cmd.sessionId);
  const attachLog = async (): Promise<void> => {
    const sessionsDir = join(ctx.config.dataDir, "sessions");
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    await enforceMode(sessionsDir, 0o700);
    ctx.tmux.pipePane(cmd.socket, cmd.sessionId, logFile);
  };
  if (cmd.bestEffortLog === true) {
    // Revive parity (Task 1's wire flag, twin of LaunchPlan.bestEffortLog):
    // the pane is live and the row must come back even when the replay log
    // refuses to attach — and "attach" is BOTH steps, a throwing mkdir is as
    // fatal as a throwing pipe-pane, so one wrap covers the pair.
    try {
      await attachLog();
    } catch (err) {
      log(
        `log attach (dir/pipe-pane) failed for ${cmd.sessionId}; reviving without the log pipe: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    await attachLog(); // STRICT (createSession parity): a throw fails the launch
  }

  // (8) Initial geometry — cosmetic: a refused resize must not fail a live pane.
  if (cmd.cols !== undefined && cmd.rows !== undefined) {
    try {
      ctx.tmux.resizeWindow(cmd.socket, cmd.sessionId, cmd.cols, cmd.rows);
    } catch (err) {
      log(
        `resize ${cmd.cols}x${cmd.rows} failed for ${cmd.sessionId} (cosmetic, continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // (9) Death reporting from here on is the shared watcher's job (report.ts).
  // The socket rides straight in from the wire — no meta re-read microseconds
  // after step (4) wrote it. LOAD-BEARING ORDER: the meta record (step 4) is
  // written BEFORE this call — report.ts's residual-window guard counts on a
  // relaunch having re-asserted its meta by the time a stale tick could
  // forget it. Do not sink startExitWatcher below a meta gap.
  startExitWatcher(ctx, cmd.sessionId, cmd.socket);
  return { ok: true };
}
