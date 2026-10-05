import { homedir } from "node:os";
import { findBinary } from "@internal/pane-runtime";

/**
 * Shared plumbing for the SSH command arms (spec SSH-SUPPORT.md §3/§4).
 *
 * The one question every SSH executor asks first is WHERE the ssh binary is,
 * and every answer must come from the node's own lookup ladder at this
 * instant — never a path shipped over the wire (§2's inversion posture: the
 * plane approves the destination, the machine owns the argv construction
 * including which binary executes it). `SUBSHELL_SSH_PATH` is the operator
 * override seam (the `CLAUDE_PATH` posture), and the knownPaths list is the
 * union of OpenSSH install locations on the supported platforms (Linux/macOS,
 * §1) — PATH first through the ladder, these as the fallbacks it names.
 */

/** env-override seam for the ssh binary, spelled like the harness overrides. */
export const SSH_BINARY_ENV = "SUBSHELL_SSH_PATH";

/** The known install locations the ladder falls back to. */
const SSH_KNOWN_PATHS = ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];

/** Resolve the ssh binary for this machine, or null. */
export async function resolveSshBin(): Promise<string | null> {
  return await findBinary("ssh", SSH_BINARY_ENV, SSH_KNOWN_PATHS);
}

/** The connecting account's home, the same way the daemon itself sees it. */
export function connectingHomeDir(): string {
  return process.env.HOME || homedir();
}
