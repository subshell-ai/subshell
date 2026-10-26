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
 * The `screen` half comes from the display registry (Task 7): a pane with a
 * registered display answers `screen: { display, viewer }`, describing its
 * viewer protocol and port. An unregistered one answers `screen: null`. When the
 * registry's dead-mid-pane marker names a binary that died while the pane
 * lived, the answer pairs the null with `screenLost: <binary>` (the
 * validator's pairing rule refuses the two non-null together): the SPA can
 * say WHY the Screen affordance is gone instead of silence. A context with
 * no registry handle (every pre-Task-7 fake) answers null exactly like the
 * old hardwire.
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
  // The display registry read (Task 7's wiring): a registered display rides
  // the scan as the plane's viewer-port discriminator, and the dead-mid-pane
  // marker pairs with the null exactly the validator's pairing rule wants.
  // No registry handle answers null, which is what every pre-Task-7 fake
  // (and every pane without a screen) still gets.
  const screen = ctx.previewDisplays?.getFor(cmd.paneId) ?? null;
  const screenLost = screen === null ? (ctx.previewDisplays?.lostFor(cmd.paneId) ?? null) : null;
  const r = await scan({ panePid, screen });
  return {
    ok: true,
    data: { ports: r.ports, cdpPort: r.cdpPort, screen: r.screen, ...(screenLost ? { screenLost } : {}) },
  };
}
