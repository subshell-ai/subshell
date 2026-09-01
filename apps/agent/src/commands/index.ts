import type { NodeCommandBody } from "@internal/session-protocol";
import {
  execCapture,
  execInput,
  execInventory,
  execKill,
  execProbe,
  execProbeResume,
  execRemovePaths,
  execResize,
  execStatDir,
  execTerminate,
} from "./basics.js";
import type { CommandContext, CommandResult } from "./context.js";

export type { CommandContext, CommandResult, CommandWs, TailHandle } from "./context.js";

/**
 * The command switch (spec 2026-08-31 §7): wired types from phase-2 Task 3 are
 * `ping`, `inventory`, `terminate`, `kill`, `input`, `resize`, `capture`,
 * `stat_dir`, `probe`, `probe_resume`, `remove_paths`. Everything else —
 * `launch` (Task 4), `prompt_deliver`/`log_read`/`tail_*` (Task 5),
 * `write_file` (Task 6) — answers `unsupported` until its task flips it; that
 * answer is the integration contract letting the backend and agent tracks
 * move independently.
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
      case "inventory":
        return await execInventory(ctx);
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
      case "stat_dir":
        return await execStatDir(ctx, cmd);
      case "probe":
        return await execProbe(ctx, cmd);
      case "probe_resume":
        return await execProbeResume(ctx, cmd);
      case "remove_paths":
        return await execRemovePaths(ctx, cmd);
      default:
        // launch/…/write_file land in later tasks; `unsupported` is the contract answer.
        return { ok: false, error: "unsupported" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
