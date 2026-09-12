import { AGENT_LOG_CAP_BYTES, agentLogPath, readAgentLogSlice } from "../log-file.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `agent_log_read`: a byte range of the agent's OWN log file.
 *
 * Not `log_read`, which is a SUBSHELL's pane log — a file that holds what an
 * operator typed, pasted tokens included. These two must never be reachable
 * through one name, and the distance between the names is the whole guard.
 *
 * The read is capped twice: by the caller's `maxBytes` and by the file's own
 * size cap, so no single result frame can carry more than the file can hold.
 */
export async function execAgentLogRead(_ctx: CommandContext, cmd: Cmd<"agent_log_read">): Promise<CommandResult> {
  const maxBytes = Math.min(cmd.maxBytes, AGENT_LOG_CAP_BYTES);
  const slice = await readAgentLogSlice(agentLogPath(), cmd.fromByte, maxBytes);
  return { ok: true, data: { ...slice } };
}
