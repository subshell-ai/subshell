import type { NodeCommandBody } from "@internal/subshell-protocol";
import { execAgentLogRead } from "./agent-log.js";
import {
  execCapture,
  execDetect,
  execInput,
  execInventory,
  execKill,
  execPaneSize,
  execPathExists,
  execProbe,
  execRemovePaths,
  execResize,
  execSetAllowedDirs,
  execStatDir,
  execTerminate,
} from "./basics.js";
import type { CommandContext, CommandResult } from "./context.js";
import { execFsLs } from "./fs-ls.js";
import { execLaunch } from "./launch.js";
import { execPromptDeliver } from "./prompt.js";
import { execService } from "./service.js";
import { execSetLogLevel } from "./set-log-level.js";
import { execSetMaintenance } from "./set-maintenance.js";
import { execSetServerUrl } from "./set-server-url.js";
import { execLogRead, execTailStart, execTailStop } from "./tail.js";
import { execUpdate } from "./update.js";
import { execWriteFile } from "./write-file.js";

export type { CommandContext, CommandResult, CommandWs, TailHandle } from "./context.js";

/**
 * The command switch (spec 2026-08-31 §7): wired types from phase-2 Tasks 3–6
 * are `ping`, `inventory`, `terminate`, `kill`, `input`, `resize`, `capture`,
 * `stat_dir`, `probe`, `path_exists` (the generalised `probe_resume`,
 * inversion spec §5), `remove_paths`, `launch`,
 * `prompt_deliver`, `log_read`, `tail_start`, `tail_stop`, `write_file`,
 * `set_allowed_dirs`, `service`, `agent_log_read`, `set_server_url`, `set_log_level`
 * (Task 6), `fs_ls` (remote folder picker), `detect` (detection-on-demand,
 * inversion spec §4), and `update` (self-replacement, spec 2026-09-15 §5.2 —
 * the one command whose wire shape is frozen, because the plane sends it to
 * agents whose protocol it does not share). Any
 * unknown type still answers `unsupported` — the integration
 * contract that lets the backend and agent tracks move independently.
 *
 * `plugin_install` and `plugin_uninstall` CENSUS note (inversion §6, closed by
 * protocol 3): the node held no plugins, so their handlers went first; the
 * commands themselves then left the WIRE — the frame parser answers them
 * `null` before dispatch, so this switch never sees them. The census moved to
 * the protocol test (`__tests__/node-frames.test.ts`, "plugin commands
 * (removed in protocol 3)"); the `unsupported` arm is back to being the
 * contract answer for FUTURE unknown types only.
 *
 * TOTAL by construction: the whole switch is wrapped once, so no executor
 * throw — not even the meta store's bad-id throw — escapes. The daemon stays
 * the only place that SENDS the result frame; this function only computes it.
 *
 * @param ctx - the per-daemon execution context (config, tmux, meta, ws seam)
 * @param cmd - the verified `cmd` claim of a signed command
 * @returns the result body for the `result{ref: jti}` frame
 */
export async function dispatchCommand(ctx: CommandContext, cmd: NodeCommandBody): Promise<CommandResult> {
  try {
    switch (cmd.type) {
      case "ping":
        return { ok: true, data: "pong" };
      case "launch":
        return await execLaunch(ctx, cmd);
      case "inventory":
        return await execInventory(ctx);
      case "detect":
        return await execDetect(ctx, cmd);
      case "terminate":
        return await execTerminate(ctx, cmd);
      case "kill":
        return await execKill(ctx, cmd);
      case "input":
        return await execInput(ctx, cmd);
      case "resize":
        return await execResize(ctx, cmd);
      case "capture":
        return await execCapture(ctx, cmd);
      case "pane_size":
        return await execPaneSize(ctx, cmd);
      case "prompt_deliver":
        return await execPromptDeliver(ctx, cmd);
      case "stat_dir":
        return await execStatDir(ctx, cmd);
      case "fs_ls":
        return await execFsLs(ctx, cmd);
      case "probe":
        return await execProbe(ctx, cmd);
      case "path_exists":
        return await execPathExists(ctx, cmd);
      case "log_read":
        return await execLogRead(ctx, cmd);
      case "tail_start":
        return await execTailStart(ctx, cmd);
      case "tail_stop":
        return await execTailStop(ctx, cmd);
      case "remove_paths":
        return await execRemovePaths(ctx, cmd);
      case "set_allowed_dirs":
        return await execSetAllowedDirs(ctx, cmd);
      case "write_file":
        return await execWriteFile(ctx, cmd);
      case "service":
        return await execService(ctx, cmd);
      case "agent_log_read":
        return await execAgentLogRead(ctx, cmd);
      case "set_log_level":
        return execSetLogLevel(ctx, cmd);
      case "set_maintenance":
        return execSetMaintenance(ctx, cmd);
      case "set_server_url":
        return await execSetServerUrl(ctx, cmd);
      case "update":
        return await execUpdate(ctx, cmd);
      default:
        return { ok: false, error: "unsupported" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
