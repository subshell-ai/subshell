import { parseNodeCommandBody, type SshRuntimeCommandFrame } from "@internal/subshell-protocol";
import {
  execCapture,
  execDetect,
  execInput,
  execKill,
  execPaneCursor,
  execPaneSize,
  execProbe,
  execRemovePaths,
  execResize,
  execStatDir,
  execTerminate,
} from "../commands/basics.js";
import type { CommandContext, CommandResult } from "../commands/context.js";
import { execFsLs } from "../commands/fs-ls.js";
import { execLaunch } from "../commands/launch.js";
import { execLogRead, execTailStart, execTailStop } from "../commands/tail.js";
import { diag } from "./stdio.js";

/**
 * The runtime's command dispatcher (design 2026-10-05 §2/§6): the runtime
 * answers the SAME command bodies as the node link, under the SAME executors,
 * with one substitution - the launch body's `socket` is rewritten to the
 * deterministic per-destination socket before `execLaunch` sees it. The
 * override is load-bearing: the node link gives every pane its own tmux
 * server, and design §6's reconciliation REQUIRES one destination-wide socket
 * so a second session finds the first session's panes. Nothing else about the
 * body changes; `parseNodeCommandBody`'s launch arm is re-run on the
 * substituted object so the deep grammar that the session frame's envelope
 * check deliberately skipped is enforced here, at the machine that executes.
 *
 * Reuse is total on purpose: `execLaunch` (id gate, meta record, pane-log
 * attach, exit watcher), `execInput`/`execTerminate`/`execKill`/`execCapture`/
 * `execResize`/`execPaneSize`/`execPaneCursor`/`execProbe`/`execRemovePaths`,
 * `execLogRead`/`execTailStart`/`execTailStop`, `execFsLs`/`execStatDir` -
 * every promise those files make (input ordering, backpressure pumps, honest
 * empty reads) is inherited, not restated. Maintenance and allowlist gates
 * read the RUNTIME data dir, which has neither file, so they pass exactly as
 * an unconfigured node would - the isolation is a fact about the directory,
 * not a bypass in the code.
 *
 * `subshells_report` is answered here (a census over the meta store + tmux)
 * rather than as a node command; `close` and `rest_response` are the serve
 * loop's, not the dispatcher's.
 */

/** A frame the dispatcher cannot answer at all (unknown type, bad launch body). */
const REFUSE_UNSUPPORTED: CommandResult = { ok: false, error: "unsupported" };

/**
 * Execute one inbound command frame, minus the serve-loop-owned arms (`close`,
 * `rest_response`). The return is what becomes the frame's `result{ref}`.
 *
 * @param ctx - the runtime's execution context (runtime data dir, shared tmux, meta store, stdout ws adapter)
 * @param destSocket - the deterministic per-destination tmux socket every pane is created on (see the module doc)
 * @param frame - the already-parsed command frame
 */
export async function runRuntimeCommand(
  ctx: CommandContext,
  destSocket: string,
  frame: SshRuntimeCommandFrame,
): Promise<CommandResult> {
  switch (frame.type) {
    case "launch": {
      const body = parseNodeCommandBody(frame.cmd);
      if (body === null || body.type !== "launch") return REFUSE_UNSUPPORTED;
      // The ONLY substitution: destination socket over the per-subshell one.
      // The spread of the narrowed member keeps the `launch` discriminant, so
      // `execLaunch` receives exactly the node-link command it was written
      // against (that reuse is the whole design of this file).
      return await execLaunch(ctx, { ...body, socket: destSocket });
    }
    case "input":
      return await execInput(ctx, { type: "input", subshellId: frame.subshellId, data: frame.data });
    case "terminate":
      return await execTerminate(ctx, { type: "terminate", subshellId: frame.subshellId });
    case "kill":
      return await execKill(ctx, { type: "kill", subshellId: frame.subshellId });
    case "capture":
      return await execCapture(ctx, {
        type: "capture",
        subshellId: frame.subshellId,
        ...(frame.lines !== undefined ? { lines: frame.lines } : {}),
      });
    case "resize":
      return await execResize(ctx, {
        type: "resize",
        subshellId: frame.subshellId,
        cols: frame.cols,
        rows: frame.rows,
      });
    case "pane_size":
      return await execPaneSize(ctx, { type: "pane_size", subshellId: frame.subshellId });
    case "pane_cursor":
      return await execPaneCursor(ctx, { type: "pane_cursor", subshellId: frame.subshellId });
    case "probe":
      return await execProbe(ctx, { type: "probe", subshellIds: frame.subshellIds });
    case "log_read":
      return await execLogRead(ctx, {
        type: "log_read",
        subshellId: frame.subshellId,
        fromByte: frame.fromByte,
        maxBytes: frame.maxBytes,
      });
    case "tail_start":
      return await execTailStart(ctx, {
        type: "tail_start",
        subshellId: frame.subshellId,
        subId: frame.subId,
        fromByte: frame.fromByte,
      });
    case "tail_stop":
      return await execTailStop(ctx, { type: "tail_stop", subId: frame.subId });
    case "list_dirs":
      return await execFsLs(ctx, { type: "fs_ls", path: frame.path });
    case "stat_dir":
      return await execStatDir(ctx, { type: "stat_dir", path: frame.path });
    case "detect": {
      // The node link's detect arm re-validated DEEP here (the session frame
      // parser's envelope check is shallow, the launch arm's precedent): the
      // executor consumes `specs` as lookup rules, so the grammar that names
      // every field of a rule must pass before `detectBinary` sees one. The
      // executor itself is the agent's - one probe, one answer shape,
      // plane-parses-version posture (inversion §4), not a runtime copy.
      const body = parseNodeCommandBody({ type: "detect", specs: frame.specs, envNames: frame.envNames });
      if (body === null || body.type !== "detect") return REFUSE_UNSUPPORTED;
      return await execDetect(ctx, body);
    }
    case "remove_paths":
      return await execRemovePaths(ctx, { type: "remove_paths", paths: frame.paths });
    case "subshells_report":
      return await subshellsCensus(ctx, destSocket);
    default:
      diag(`runtime: refusing command ${String((frame as { type: string }).type)}`);
      return REFUSE_UNSUPPORTED;
  }
}

/**
 * The alive/dead census of every pane the runtime tracks (design §2's
 * `subshells_report`): the meta store's records, probed on the destination
 * socket. tmux that refuses to answer fails the batch like the node link's
 * `probe` posture (never report-alive-as-dead on a tmux blip); the census
 * caller retries.
 */
async function subshellsCensus(ctx: CommandContext, destSocket: string): Promise<CommandResult> {
  const metas = await ctx.meta.list();
  const rows: { subshellId: string; alive: boolean; exitCode: number | null }[] = [];
  for (const meta of metas) {
    const socket = meta.socket || destSocket;
    if (!(await ctx.tmux.hasSubshell(socket, meta.subshellId))) {
      rows.push({
        subshellId: meta.subshellId,
        alive: false,
        exitCode: await ctx.tmux.paneExitCode(socket, meta.subshellId),
      });
      continue;
    }
    rows.push({ subshellId: meta.subshellId, alive: true, exitCode: null });
  }
  return { ok: true, data: rows };
}

/** The census row shape, exported for the serve loop's final-report typing. */
export type RuntimeReportRow = { subshellId: string; alive: boolean; exitCode: number | null };
