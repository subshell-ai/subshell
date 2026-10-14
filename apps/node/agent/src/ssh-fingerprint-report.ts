/**
 * The §4.6 SSH trust block, computed from THIS machine's own files (spec
 * 2026-10-08 §4.5/§4.6): both fingerprints of the node's own keypair (from
 * `identity.ts`) and both fingerprints of every relay peer pinned in
 * `machine-pin-store.ts`.
 *
 * This is the out-of-band check's node half: an operator compares what one
 * machine prints here against what the PEER computes from its own private
 * keys, on the two machines' own surfaces, and the only agreement that counts
 * is byte equality of the `SHA256:` strings. Fingerprints are the DISPLAY
 * form; the store next door still enforces the raw JWK strings.
 *
 * The fingerprints come from `fingerprintJwk` (canonical SHA-256 over the DER
 * SubjectPublicKeyInfo, JWK member order cannot move it) - never a re-derive:
 * a second hash rule would let two honest machines disagree about the same
 * key, which is the exact failure this surface exists to catch.
 *
 * THROWING BY CONTRACT: an unreadable pin file or an unusable identity is
 * fail-closed noise, not an empty block, and every caller decides what the
 * absence costs (the `ready` carriage drops the block and says nothing; the
 * dashboard card simply has nothing to render).
 */
import {
  fingerprintJwk,
  type NodeSshFingerprintReport,
  type NodeSshPeerFingerprint,
} from "@internal/subshell-protocol";
import { loadOrCreateIdentity } from "./identity.js";
import { MachinePinStore } from "./machine-pin-store.js";

/**
 * Build the trust block from the node's data dir: own halves from the two
 * identity files (generating a pre-M2 node's signing pair through the
 * ordinary first-run path), peers from `ssh-machine-pins.json`, id ascending.
 * @param dataDir - the agent's configured data dir (`loadConfig()` value)
 */
export async function buildSshFingerprintReport(dataDir: string): Promise<NodeSshFingerprintReport> {
  const identity = await loadOrCreateIdentity(dataDir);
  const own = {
    signing: await fingerprintJwk(identity.signingPublicJwk),
    encryption: await fingerprintJwk(identity.publicJwk),
  };
  const peers: NodeSshPeerFingerprint[] = [];
  for (const { nodeId, pin } of new MachinePinStore(dataDir).entries()) {
    peers.push({
      nodeId,
      signing: await fingerprintJwk(pin.signing),
      encryption: await fingerprintJwk(pin.encryption),
    });
  }
  return { own, peers };
}
