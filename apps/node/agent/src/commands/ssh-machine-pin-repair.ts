import {
  bytesOfJwk,
  type JsonValue,
  parseNodeSshMachinePinRepair,
  type SshMachinePinRepairCommand,
} from "@internal/subshell-protocol";
import { MachinePinStore } from "../machine-pin-store.js";
import type { CommandContext, CommandResult } from "./context.js";
import { decodePeerEncryptionJwk } from "./ssh-shared.js";

/**
 * `ssh_machine_pin_repair` (spec 2026-10-08 §4.5, Task 17): replace ONE
 * peer's entry in this machine's pin store with the peer's registered public
 * pair, which the plane re-delivers in the command. This is the recovery for
 * a genuinely rotated peer key (a re-enroll or a replaced data dir, §4.2) -
 * the ONLY sanctioned way a pinned entry changes, and the design has no
 * "trust anyway" escape beside it: byte-strict {@link MachinePinStore.check}
 * still governs every NORMAL pairing, so an UN-repaired peer stays blocked.
 *
 * The three rules this arm keeps:
 * - **Validation before any write.** The grammar already refused a top-level
 *   `d`; this is the deep half (the relay-open branches' own standard, beside
 *   the import): `bytesOfJwk` on the signing half, decode + `bytesOfJwk` on
 *   the encryption half. A JWK that is not an importable PUBLIC P-256 key -
 *   private material anywhere, a foreign curve, junk - refuses with nothing
 *   written. The store keeps its single job: byte-faithful persistence.
 * - **The gate does NOT speak here** (deliberate, the `ssh_register_identity`
 *   precedent restated): re-pair is a trust-record act on this machine's own
 *   store, not an SSH act through the connecting account - it spawns nothing,
 *   reads no config, touches no agent. And the recovery must reach a machine
 *   whose pairing is currently BLOCKED; requiring the gate to be open would
 *   make the repair of a stuck relationship depend on the relationship. The
 *   authorization is the plane's owner-of-A gate plus the command signature;
 *   the mirror is not consulted and the store's always-strict doctrine
 *   (`SUBSHELL_CHANNEL_PIN` ignored) is unchanged.
 * - **No audit row here, no key bytes anywhere near a log line.** The audit
 *   is the plane's `node.ssh_machine_pin.repair`, ids only (docs/security.md
 *   §10); the ack echoes the peer id and nothing else. The refusal strings
 *   name the peer id and the shape of the problem, never the delivered
 *   material (node refusals ride the RESULT channel and the plane may log
 *   them - the T8 posture inherited).
 */
export function execSshMachinePinRepair(ctx: CommandContext, cmd: SshMachinePinRepairCommand): CommandResult {
  // A machine pinning ITSELF is a contradiction the pairing design has no
  // word for; the plane's own service refuses it upstream, and the machine
  // re-checks because the transport that got the command here is the only
  // witness to which machine it was addressed to.
  if (cmd.peerNodeId === ctx.config.nodeId) {
    return { ok: false, error: "machine pin repair refused: a machine is never its own relay peer" };
  }
  let pin: { signing: string; encryption: string };
  try {
    pin = {
      signing: cmd.peerSigningPublicKey,
      encryption: decodePeerEncryptionJwk(cmd.peerEncryptPublicKey),
    };
    bytesOfJwk(pin.signing); // deep public-only validity on the signing half too
  } catch (err) {
    return {
      ok: false,
      error: `machine pin repair refused: peer key rejected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const pins = new MachinePinStore(ctx.config.dataDir);
  try {
    pins.repair(cmd.peerNodeId, pin);
  } catch (err) {
    // The store's fail-closed read (a corrupt file quarantines and THROWS):
    // the repair of one peer must never ride out over an unreadable pin set.
    return {
      ok: false,
      error: `machine pin repair refused: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const validated = parseNodeSshMachinePinRepair({ repaired: true, peerNodeId: cmd.peerNodeId });
  if (validated === null) return { ok: false, error: "malformed repair ack" };
  // The seam cast: JSON-safe by construction, contract owned by `node-results.ts`.
  return { ok: true, data: validated as unknown as JsonValue };
}
