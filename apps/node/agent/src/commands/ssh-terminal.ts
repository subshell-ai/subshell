import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  buildSshInvocation,
  initTerminalForLaunch,
  remoteTerminalLine,
  renderSshConfigContents,
  sshChildPath,
  sshTerminalEnvPairs,
  sshTerminalPaneCommand,
  terminalLogPath,
  transitionControl,
} from "@internal/pane-runtime";
import {
  type JsonValue,
  NODE_RESULT_MAINTENANCE,
  NODE_RESULT_SSH_GENERATION_STALE,
  parseNodeSshControlResult,
} from "@internal/subshell-protocol";
import { log } from "../log.js";
import { readMaintenance, reportableMaintenance } from "../maintenance.js";
import { selfInvocation } from "../self-invoke.js";
import { isSubshellId } from "../subshell-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { reportMaintenance, startExitWatcher } from "./report.js";
import { connectingHomeDir, resolveSshBin } from "./ssh-shared.js";

/**
 * The managed SSH terminal executors (SSH-SUPPORT.md §3, Interactive
 * terminals): `ssh_terminal_launch` and `ssh_input_control`.
 *
 * The pane's FOREGROUND process is ssh — no connecting-node shell, no
 * fallback, exit ends the pane. That is the whole inversion carried over from
 * `launch`, applied to a binary this machine picks itself: the plane ships
 * the APPROVED DESTINATION (the snapshot), and this file builds the argv and
 * the `env -i` pane string around it from the frozen renderer, so the only
 * shell string tmux ever sees is one whose every token this code quoted
 * (the `shellQuote`-on-every-token load-bearing defense, stated once in
 * `assembleHarnessCommand` and honored here).
 *
 * Two deliberate divergences from `execLaunch`, each a consequence of §2/§3
 * rather than style:
 *
 * - **No `pane-died` exit hook.** The hook line carries the pane's
 *   `SUBSHELL_*` credentials, and "Do not mint MCP credentials or inject
 *   Subshell credentials into SSH processes" means an SSH pane cannot own
 *   one. Death reporting falls to the shared exit watcher (the hook's
 *   backstop, and always-on whenever the hook could not exist).
 * - **No preset/subshell env layers.** The pane env is exactly
 *   `sshTerminalEnvPairs`: allowlisted host facts plus an agent socket ONLY
 *   when the approved snapshot names one.
 */

/** Execute `ssh_terminal_launch`. */
export async function execSshTerminalLaunch(
  ctx: CommandContext,
  cmd: Cmd<"ssh_terminal_launch">,
): Promise<CommandResult> {
  if (!isSubshellId(cmd.subshellId)) return { ok: false, error: "invalid subshell id" };

  // Maintenance first, exactly like `launch`: this machine took itself out of
  // service, and a NEW pane is precisely what it stops accepting. Bare
  // constant so the plane maps by equality.
  const maintenance = readMaintenance(ctx.config.dataDir);
  if (maintenance.kind === "unreadable" || (maintenance.kind === "state" && maintenance.state.on)) {
    const state = reportableMaintenance(maintenance);
    if (state) reportMaintenance(ctx, state);
    return { ok: false, error: NODE_RESULT_MAINTENANCE };
  }

  // The pane's local cwd is the node's OWN data dir (a root this machine
  // seeded at enroll; the ssh foreground process ignores it). The operator
  // directory allowlist is NOT consulted: it gates where launched panes start
  // in the connecting filesystem, and this pane's destination is the approved
  // snapshot, not a local directory anyone could wander into.
  const sshBin = await resolveSshBin();
  if (sshBin === null) return { ok: false, error: "ssh binary missing: ssh" };
  const home = connectingHomeDir();

  // Terminal state BEFORE the pane exists: log generation bumped, old log
  // segments cleared, control state preserved (a restart of the row is a new
  // session, not a continuation of any held cursor — and anything fenced
  // before stays fenced).
  initTerminalForLaunch(ctx.config.dataDir, cmd.subshellId);

  // The rendered per-pane config, 0600, O_EXCL after unlink (an existing
  // file could only be this subtree's previous config or an intruder's
  // object; either way the fresh pane must run against bytes it just wrote).
  const termDir = join(ctx.config.dataDir, "ssh", "terminals");
  mkdirSync(termDir, { recursive: true });
  const configPath = join(termDir, `${cmd.subshellId}.config`);
  writeFreshFile(configPath, renderSshConfigContents(cmd.snapshot));

  const sshArgv = buildSshInvocation({
    sshBin,
    snapshot: cmd.snapshot,
    configPath,
    // NO remote command here: `sshTerminalPaneCommand` appends the cd +
    // login-shell line as its own quoted final token, so the destination
    // argv builder stays the single "route" artifact shared with runs.
  });
  const paneCmd = sshTerminalPaneCommand(
    sshTerminalEnvPairs(cmd.snapshot, home, await sshChildPath()),
    sshArgv,
    remoteTerminalLine(cmd.remoteDir),
  );

  await ctx.meta.record({
    subshellId: cmd.subshellId,
    cwd: ctx.config.dataDir,
    socket: cmd.socket,
    harnessId: "ssh",
    name: cmd.subshellId,
    startedAt: new Date(ctx.nowMs()).toISOString(),
  });
  try {
    // No exit hook (see module doc): the watcher owns this pane's death.
    ctx.tmux.newSubshell(cmd.socket, cmd.subshellId, ctx.config.dataDir, paneCmd);
  } catch (err) {
    await ctx.meta.forget(cmd.subshellId); // nothing spawned — no orphan root for the policy
    throw err;
  }

  // Capture at the CONVENTIONAL pane-log path so the existing tail pumps,
  // replay, and log_read work unchanged; bounded rotation (generation + one
  // rotated segment) is the ssh sweep's job, and the re-armed child this
  // initial pipe-pane starts is the same self-invoked `pane-log` verb.
  ctx.tmux.pipePane(
    cmd.socket,
    cmd.subshellId,
    terminalLogPath(ctx.config.dataDir, cmd.subshellId),
    selfInvocation("pane-log"),
  );

  startExitWatcher(ctx, cmd.subshellId, cmd.socket);

  if (cmd.cols !== undefined && cmd.rows !== undefined) {
    try {
      await ctx.tmux.resizeWindow(cmd.socket, cmd.subshellId, cmd.cols, cmd.rows);
    } catch (err) {
      log(
        `ssh terminal resize ${cmd.cols}x${cmd.rows} failed for ${cmd.subshellId} (cosmetic, continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { ok: true };
}

/**
 * Execute `ssh_input_control`: move mode, RAISE the generation, and answer
 * the state that took effect (§4: the echo lets the plane detect a lost race
 * against a takeover happening at the machine). A transition that would LOWER
 * the generation is refused with the one frozen spelling every generation
 * refusal uses, so input fences cannot be beaten by replay.
 */
export async function execSshInputControl(ctx: CommandContext, cmd: Cmd<"ssh_input_control">): Promise<CommandResult> {
  if (!isSubshellId(cmd.subshellId)) return { ok: false, error: "invalid subshell id" };
  const transition = transitionControl(ctx.config.dataDir, cmd.subshellId, cmd.mode, cmd.generation);
  if (transition.kind === "stale") return { ok: false, error: NODE_RESULT_SSH_GENERATION_STALE };
  const data = parseNodeSshControlResult({
    subshellId: cmd.subshellId,
    mode: transition.state.mode,
    generation: transition.state.generation,
  });
  if (data === null) return { ok: false, error: "malformed control result" };
  return { ok: true, data: data as unknown as JsonValue };
}

function writeFreshFile(path: string, content: string): void {
  try {
    unlinkSync(path); // refuse to TRUNCATE someone else's object by name; create only after the name is free
  } catch {
    // nothing there
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
