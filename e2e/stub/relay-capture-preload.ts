/**
 * E2E-only preload (bun `--preload`) for spec 23's backend child: it swaps in
 * a RECORDING wrapper around the plane's relay-broker singleton so the spec
 * can assert the §5.5 posture on the REAL exchange - "a plane-side wire
 * capture shows only opaque envelopes + plaintext routing ids".
 *
 * The wrapper sits at exactly the point the plane sees a relay frame: after
 * the node link is opened (the plane's decrypted view) and before the blind
 * copy to the peer. It records `{ref, seq, direction, blob}` - the same fields
 * the broker forwards, blob as the opaque base64 JWE it already is - plus the
 * named closes, one JSON line per event, to the file named by
 * `E2E_RELAY_CAPTURE`. Inert when the env is unset, so no other spec's
 * backend is affected. The recording is test scaffolding under the run's own
 * temp root, unsealed content stays SEALED (the blob is ciphertext to the
 * plane exactly as to the recorder), and the root is deleted with the run.
 *
 * This is the sanctioned test seam (`setRelayBrokerForTests` exists for
 * suites that point the routing entry at a recorder); the wrapper delegates
 * everything, so the brokered session is the production broker's own.
 *
 * Imports the service module by path (bun runs the backend from source); the
 * import is the same module instance the server loads later (same realpath),
 * which is why the swap reaches the handler's lazy `getRelayBroker()`.
 */
import { appendFileSync } from "node:fs";
import type { RelayFrame, SshRelayCloseReason } from "@internal/subshell-protocol";
import {
  getRelayBroker,
  type RelayBroker,
  setRelayBrokerForTests,
} from "../../apps/server/api/src/services/ssh-relay.service.js";

const CAPTURE_ENV = "E2E_RELAY_CAPTURE";

/** One captured plane-side event: a routed frame or a named close. */
interface CaptureLine {
  t: number;
  kind: "frame" | "close";
  nodeId?: string;
  frame?: RelayFrame;
  ref?: string;
  reason?: string;
}

const file = process.env[CAPTURE_ENV];
if (file !== undefined && file !== "") {
  const real = getRelayBroker(); // builds the production singleton; then we wrap it
  const record = (line: CaptureLine): void => {
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch {
      /* a capture must never take the plane down */
    }
  };
  const wrapper: RelayBroker = {
    ...real, // Preserve every broker operation, including identity repair and shutdown.
    routeRelayFrame: (nodeId, frame) => {
      record({ t: Date.now(), kind: "frame", nodeId, frame });
      real.routeRelayFrame(nodeId, frame);
    },
    closeRelay: (ref, reason: SshRelayCloseReason) => {
      record({ t: Date.now(), kind: "close", ref, reason });
      return real.closeRelay(ref, reason);
    },
  };
  setRelayBrokerForTests(wrapper);
}
