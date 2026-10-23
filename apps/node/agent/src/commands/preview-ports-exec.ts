import { getPreviewEnabled } from "../preview/flags.js";
import { type PanePortsScan, type ScanPanePortsOptions, scanPanePorts } from "../preview/ports.js";
import { resolveSocket } from "./basics.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * The `preview_ports_get` arm (pane-preview spec §4, Task 4): the plane asks
 * what a pane is serving, this machine answers in one stateless pass. The
 * refusal WORDS are shared across the preview arms — {@link PREVIEW_NODE_OFF}
 * is the voice every gated preview act answers with when this machine's
 * switch is off, so "every entry point refuses with one voice" is a constant,
 * not three strings that drift.
 *
 * Gate-first, like every SSH arm consults its mirror before mechanics: a
 * machine switched off refuses the same whether the pane is alive, dead, or
 * nonexistent, and no process table is walked for a refusal the switch
 * already answers. The pane's liveness is the next gate — `panePid` is the
 * tmux server's own word on where the pane's process starts, so a refused
 * `preview-ports-pane-gone` means the server says the pane is gone (a tmux
 * error reads the same and is answered the same: the plane re-checks).
 *
 * The `screen` half is HARDWIRED null for this task: the display registry is
 * Task 7's, and until it exists this node allocates no displays. The arm
 * passes `screen: null` to the scan and returns what the scan echoes, so
 * Task 7 amends exactly one call site. `screenLost` (the validator's
 * companion member) is likewise never set here — there is no display to have
 * lost.
 */

/** The one-word switch-off refusal every preview arm shares, with the operator's remedy named. */
export const PREVIEW_NODE_OFF = "preview-node-off: turn on Preview for this node";

/** The pane the command names is not running here (anymore, or never). */
export const PREVIEW_PORTS_PANE_GONE = "preview-ports-pane-gone";

/** Injectable scan seam (test-only; production is the real /proc walk), the `RelayOpenSeams` habit. */
export interface PreviewPortsSeams {
  scan?: (opts: ScanPanePortsOptions) => Promise<PanePortsScan>;
}

/**
 * Execute `preview_ports_get`: switch → pane → scan, in that order.
 * A malformed pane id refuses `invalid subshell id` through
 * {@link resolveSocket}'s throw, before tmux is asked anything — the same
 * id gate every pane executor runs first.
 */
export async function execPreviewPorts(
  ctx: CommandContext,
  cmd: Cmd<"preview_ports_get">,
  seams?: PreviewPortsSeams,
): Promise<CommandResult> {
  // The mirror is asked, fail-CLOSED: a permit is `on === true` and nothing
  // else (absent, off, and unreadable all refuse) — flags.ts states the rule
  // once, this arm just applies it before any work.
  if (getPreviewEnabled(ctx.config.dataDir)?.on !== true) return { ok: false, error: PREVIEW_NODE_OFF };
  const socket = await resolveSocket(ctx, cmd.paneId);
  const panePid = await ctx.tmux.panePid(socket, cmd.paneId);
  if (panePid === null) return { ok: false, error: PREVIEW_PORTS_PANE_GONE };
  const scan = seams?.scan ?? scanPanePorts;
  const r = await scan({ panePid, screen: null });
  return { ok: true, data: { ports: r.ports, cdpPort: r.cdpPort, screen: r.screen } };
}
