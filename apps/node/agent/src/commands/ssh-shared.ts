import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { CommandContext } from "./context.js";

export {
  connectingHomeDir,
  decodePeerEncryptionJwk,
  knownHostsPath,
  resolveSshBin,
  resolveSshKeygenBin,
  SSH_BINARY_ENV,
  SSH_GATE_REFUSAL,
  SSH_KEYGEN_BINARY_ENV,
} from "@internal/pane-runtime";

/**
 * Does this machine permit SSH right now? THE gate every SSH arm asks first,
 * so it lives once here rather than at each call site: it reads the node's
 * local `ssh-enabled` mirror and fails CLOSED (an unreadable or absent mirror
 * refuses), regardless of what the plane's row believes. A future change to
 * the mirror's three-state read has exactly one home to be wrong in.
 */
export function gateOpen(ctx: CommandContext): boolean {
  return sshAllowed(readSshEnabled(ctx.config.dataDir));
}
