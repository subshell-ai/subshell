import { homedir } from "node:os";
import { findBinary } from "../../binary-lookup.js";

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

/** env-override seam for ssh-keygen, the `ssh_host_key` capture arm's binary (Task 12). */
export const SSH_KEYGEN_BINARY_ENV = "SUBSHELL_SSH_KEYGEN_PATH";

/** The known install locations the ladder falls back to. */
const SSH_KNOWN_PATHS = ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];

/** ssh-keygen's install locations: the same packages that ship `ssh`, beside it. */
const SSH_KEYGEN_KNOWN_PATHS = [
  "/usr/bin/ssh-keygen",
  "/bin/ssh-keygen",
  "/usr/local/bin/ssh-keygen",
  "/opt/homebrew/bin/ssh-keygen",
];

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

/** Resolve the ssh-keygen binary for this machine, or null (the `ssh_host_key` arm). */
export async function resolveSshKeygenBin(): Promise<string | null> {
  return await findBinary("ssh-keygen", SSH_KEYGEN_BINARY_ENV, SSH_KEYGEN_KNOWN_PATHS);
}

/**
 * The connecting account's `known_hosts` trust file - the capture source
 * (spec 2026-10-08 §9: A's trust in D is read from A's OWN file). Overridable
 * by env for tests and non-default homes, exactly like the binary seams; the
 * default is `~/.ssh/known_hosts`.
 */
export function knownHostsPath(): string {
  const override = process.env.SUBSHELL_SSH_KNOWN_HOSTS;
  if (override !== undefined && override !== "") return override;
  return `${connectingHomeDir()}/.ssh/known_hosts`;
}

/** The connecting account's home, the same way the daemon itself sees it. */
export function connectingHomeDir(): string {
  return process.env.HOME || homedir();
}
