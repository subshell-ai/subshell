import { NODE_MAX_FRAME_BYTES, PREVIEW_LANE_BUFFER_MAX_BYTES, type RelayFrame } from "@internal/subshell-protocol";
import { binaryPayload } from "./link-crypto.js";
import type { PreviewLaneEvent } from "./preview/forward.js";

/**
 * The daemon's byte-lane pump, factored out of `daemon.ts` so the
 * deliver-or-throw contract is testable without a socket (Task 8 acceptance
 * (c), the node-side mirror of the plane's `sendRelayFrameOverNodeSocket`).
 * Since pane-preview Task 5 the SAME pump carries the preview lanes' events
 * (`preview_data` out, `preview_closed`): the lane's slow-link accounting
 * reads this throw, and one sealed path for every lane frame is what keeps
 * the two byte legs' delivery promises identical by construction.
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
  ws?:
    | {
        send(data: string | Buffer): unknown;
        close?(code?: number, reason?: string): void;
        readonly bufferedAmount?: number;
        readonly readyState?: number;
      }
    | undefined;
  link?: RelaySendLink | undefined;
}

/**
 * Build the pump over a state getter. Throws {@link Error} with a named
 * reason on: no live socket (between connections), no established link (a
 * protocol-18 socket has no plaintext path at all), an oversize envelope, or
 * a failing write. On success the socket received a Buffer of sealed bytes.
 */
export function createDaemonRelaySend(getState: () => RelaySendState): (frame: RelayFrame | PreviewLaneEvent) => void {
  return (frame: RelayFrame | PreviewLaneEvent): void => {
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
    if (frame.type !== "relay") {
      if (ws.readyState !== undefined && ws.readyState !== 1) throw new Error("preview transport is not open");
      // Reserve space for the secretstream header and tag before sealing:
      // a rejected frame must not advance the link's encryption state.
      if ((ws.bufferedAmount ?? 0) + size + 128 > PREVIEW_LANE_BUFFER_MAX_BYTES) {
        throw new Error("preview transport exceeded its buffer budget");
      }
    }
    try {
      ws.send(binaryPayload(session.sealFrame(payload)));
    } catch (err) {
      // Once sealed, the frame cannot be skipped on this secretstream.
      if (frame.type !== "relay") {
        try {
          ws.close?.(1011, "preview transport write failed");
        } catch {
          /* already closed */
        }
      }
      throw err;
    }
  };
}
