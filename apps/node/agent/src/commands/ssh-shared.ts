import { homedir } from "node:os";
import { findBinary } from "@internal/pane-runtime";

/**
 * Shared plumbing for the SSH command arms (spec 2026-10-07 §5).
 *
 * The one question every SSH executor asks first is WHERE the ssh binary is,
 * and every answer must come from the node's own lookup ladder at this
 * instant — never a path shipped over the wire (inversion spec §5: the argv
 * is built on the control plane, the binary is resolved here; the plane
 * approves the destination and composes the command, this machine answers
 * which ssh(1) executes it). `SUBSHELL_SSH_PATH` is the operator
 * override seam (the `CLAUDE_PATH` posture), and the knownPaths list is the
 * union of OpenSSH install locations on the supported platforms (Linux/macOS)
 * — PATH first through the ladder, these as the fallbacks it names.
 *
 * The gate comes BEFORE any of this: every SSH arm consults the local
 * ssh-enabled mirror first (spec §4.3), so nothing here runs on a machine
 * that has not been switched on. `SSH_GATE_REFUSAL` (ssh-aliases.ts) states
 * the one refusal every arm shares.
 */

/** env-override seam for the ssh binary, spelled like the harness overrides. */
export const SSH_BINARY_ENV = "SUBSHELL_SSH_PATH";

/** The known install locations the ladder falls back to. */
const SSH_KNOWN_PATHS = ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];

/**
 * The gate's own words, spelled once: a machine whose local mirror is not ON
 * refuses EVERY SSH command with exactly this, before any binary lookup or
 * spawn. The plane's row is not consulted here — the mirror is the fact this
 * process acts on, and it fails closed (absent and unreadable both refuse).
 */
export const SSH_GATE_REFUSAL = "ssh disabled on this node";

/** Resolve the ssh binary for this machine, or null. */
export async function resolveSshBin(): Promise<string | null> {
  return await findBinary("ssh", SSH_BINARY_ENV, SSH_KNOWN_PATHS);
}

/** The connecting account's home, the same way the daemon itself sees it. */
export function connectingHomeDir(): string {
  return process.env.HOME || homedir();
}
