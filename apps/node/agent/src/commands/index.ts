import type { NodeCommandBody } from "@internal/subshell-protocol";
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
import { execLogRead, execTailStart, execTailStop } from "./tail.js";
import { execWriteFile } from "./write-file.js";

export type { CommandContext, CommandResult, CommandWs, TailHandle } from "./context.js";

/**
 * The command switch (spec 2026-08-31 §7): wired types from phase-2 Tasks 3–6
 * are `ping`, `inventory`, `terminate`, `kill`, `input`, `resize`, `capture`,
 * `stat_dir`, `probe`, `path_exists` (the generalised `probe_resume`,
 * inversion spec §5), `remove_paths`, `launch`,
 * `prompt_deliver`, `log_read`, `tail_start`, `tail_stop`, `write_file`,
 * `set_allowed_dirs`
 * (Task 6), `fs_ls` (remote folder picker), and `detect` (detection-on-demand,
 * inversion spec §4). Any
 * unknown type still answers `unsupported` — the integration
 * contract that lets the backend and agent tracks move independently.
 *
 * `plugin_install` and `plugin_uninstall` CENSUS note (inversion §6): the node
 * holds no plugins anymore, so their handlers are gone; the v2 protocol still
 * PARSES the two command shapes (the wire removal is Task 8), so dispatch
 * answers them `unsupported` through the default arm. Pinned by a test in
 * `__tests__/commands-basics.test.ts` — this arm is load-bearing for exactly
 * these two types until the schema drops them.
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
      default:
        return { ok: false, error: "unsupported" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
