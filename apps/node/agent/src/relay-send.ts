import { NODE_MAX_FRAME_BYTES, type RelayFrame } from "@internal/subshell-protocol";
import { binaryPayload } from "./link-crypto.js";

/**
 * The daemon's relay pump, factored out of `daemon.ts` so the
 * deliver-or-throw contract is testable without a socket (Task 8 acceptance
 * (c), the node-side mirror of the plane's `sendRelayFrameOverNodeSocket`).
 *
 * `send` in the daemon LOGS a dropped event; a relay frame may not be dropped
 * quietly. The proxy parks a phantom request on a send it believes delivered
 * (T6 review, restated in T7's handoff), and the responder consumes a signed
 * seq for a reply that never left - so every non-delivery here RAISES and the
 * endpoints act on the throw (fail the request, consume no seq, stall to the
 * plane's timers). State is read through a getter because the pump is handed
 * to sessions that OUTLIVE a socket: the registry survives reconnects and the
 * plane re-pumps on the fresh link, so the frame targets whatever socket is
 * CURRENT at send time, never the socket the open rode in on.
 */

/** The negotiator slice the pump reads: the per-CONNECTION link, possibly mid-handshake. */
export interface RelaySendLink {
  established(): boolean;
  session(): { sealFrame(text: string): Uint8Array } | undefined;
}

/** The live facts at send time: the CURRENT socket (or none) and its link (or none). */
export interface RelaySendState {
  ws?: { send(data: string | Buffer): unknown } | undefined;
  link?: RelaySendLink | undefined;
}

/**
 * Build the pump over a state getter. Throws {@link Error} with a named
 * reason on: no live socket (between connections), no established link (a
 * protocol-18 socket has no plaintext path at all), an oversize envelope, or
 * a failing write. On success the socket received a Buffer of sealed bytes.
 */
export function createDaemonRelaySend(getState: () => RelaySendState): (frame: RelayFrame) => void {
  return (frame: RelayFrame): void => {
    const { ws, link } = getState();
    if (!ws) throw new Error("relay send refused: no live socket");
    const session = link?.established() ? link.session() : undefined;
    if (!session) {
      throw new Error("relay send refused: the encrypted link is not established");
    }
    const payload = JSON.stringify(frame);
    const size = Buffer.byteLength(payload);
    if (size > NODE_MAX_FRAME_BYTES) {
      throw new Error(`relay send refused: frame ${size}B exceeds the ${NODE_MAX_FRAME_BYTES}B link cap`);
    }
    ws.send(binaryPayload(session.sealFrame(payload)));
  };
}
