import { writeMcpEnabled } from "../mcp-enabled.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `set_mcp_enabled`: the plane's half of the node's MCP-use switch.
 *
 * It writes the file and NOTHING else. No pane is torn down and no child is
 * killed: the switch is consulted when a pane is composed and when `subshell
 * mcp` starts, so turning it off reaches the next launch or restart, and a
 * pane mid-conversation keeps the tools it was started with rather than losing
 * them under the agent's feet.
 *
 * The plane's own `changedAt` is stored verbatim, so both copies end
 * byte-identical; re-stamping here would have the next `ready` report a
 * disagreement the link latency invented.
 *
 * A failing write propagates: `dispatchCommand` turns the throw into
 * `{ ok: false }`, so the plane learns its push did not land instead of
 * recording a mirror that does not exist.
 *
 * @param ctx - the per-daemon execution context (data dir + the report memo)
 * @param cmd - the verified `set_mcp_enabled` command
 * @returns `{ ok: true }` once the file is on disk
 */
export function execSetMcpEnabled(ctx: CommandContext, cmd: Cmd<"set_mcp_enabled">): CommandResult {
  // Memoized as REPORTED, not merely written: the plane is this value's only
  // source, so sending it back on the next tick would be an echo the plane
  // then reconciles against itself.
  ctx.lastReportedMcpEnabled = writeMcpEnabled(ctx.config.dataDir, { on: cmd.on, changedAt: cmd.changedAt });
  return { ok: true };
}
