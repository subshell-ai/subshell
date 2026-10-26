import {
  NODE_MAX_FRAME_BYTES,
  PREVIEW_LANE_BUFFER_MAX_BYTES,
  type PreviewDataFrame,
} from "@internal/subshell-protocol";
import { getLive } from "@/modules/nodes/node-registry.js";
import { binaryPayload } from "@/modules/nodes/node-rpc.js";

/**
 * The plane-to-node leg of the preview lane (pane-preview spec §4, Task 8).
 * A `preview_data` frame is a LINK frame, not a command: lane bytes never
 * ride `sendCommand`, exactly as the relay split its own bytes from its
 * commands. This file is the sanctioned twin of `sendRelayFrameOverNodeSocket`
 * (ssh-relay.service.ts:651), kept separate rather than generalised because
 * the relay sender is load-bearing for SSH and one clone is a smaller risk
 * than one shared function with a union parameter.
 */

/** Why one lane frame did not reach the node's socket. */
export class PreviewSendError extends Error {
  constructor(
    readonly nodeId: string,
    reason: string,
  ) {
    super(`preview frame to node "${nodeId}" not delivered: ${reason}`);
    this.name = "PreviewSendError";
  }
}

/**
 * Write one preview lane frame to `nodeId`'s CURRENT live socket, sealed
 * through its established link (any node that carries preview frames speaks
 * protocol 23, whose sockets are handshake-classified). Throws
 * {@link PreviewSendError} on every non-delivery: no live connection, a
 * closing/superseded record, an unestablished link, a frame past the wire
 * cap, or a failing write. The broker reads the throw as "this lane's node
 * is gone" (the link-drop sweep then reaps the node's sessions named); a
 * silent return would strand lane subscribers on a dead pipe.
 */
export function sendPreviewFrameOverNodeSocket(nodeId: string, frame: PreviewDataFrame): void {
  const conn = getLive(nodeId);
  if (!conn) throw new PreviewSendError(nodeId, "node has no live connection");
  if (conn.closing) throw new PreviewSendError(nodeId, "connection is closing (superseded or revoked)");
  if (!conn.link) throw new PreviewSendError(nodeId, "encrypted link is not established");
  const payload = JSON.stringify(frame);
  if (Buffer.byteLength(payload) > NODE_MAX_FRAME_BYTES) {
    throw new PreviewSendError(nodeId, `frame exceeds ${NODE_MAX_FRAME_BYTES} bytes`);
  }
  if ((conn.ws.getBufferedAmount?.() ?? 0) + Buffer.byteLength(payload) + 128 > PREVIEW_LANE_BUFFER_MAX_BYTES) {
    throw new PreviewSendError(nodeId, "preview transport exceeded its buffer budget");
  }
  try {
    const sent = conn.ws.send(binaryPayload(conn.link.sealFrame(payload)));
    if (sent === 0) {
      // A sealed frame cannot be skipped in the secretstream. Reconnect
      // instead of attempting subsequent traffic with divergent key state.
      throw new Error("socket dropped the sealed frame");
    }
  } catch (err) {
    try {
      conn.ws.close(1011, "preview transport dropped a frame");
    } catch {
      /* already closed */
    }
    throw new PreviewSendError(nodeId, `socket send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
