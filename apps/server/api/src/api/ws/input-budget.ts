import type { WsSocket } from "@/api/ws/viewers.js";

// The browser sends eight 32 KiB frames at once. These limits leave room for
// retries without trusting a custom client's pacing or queue implementation.
export const INPUT_FRAME_MAX_BYTES = 64 * 1024;
export const INPUT_SOCKET_MAX_FRAMES = 512;
export const INPUT_SOCKET_MAX_BYTES = 16 * 1024 * 1024;
// A disconnected node must leave capacity for the rest of the fleet.
export const INPUT_NODE_MAX_FRAMES = 1024;
export const INPUT_NODE_MAX_BYTES = 16 * 1024 * 1024;
export const INPUT_GLOBAL_MAX_FRAMES = 4096;
export const INPUT_GLOBAL_MAX_BYTES = 64 * 1024 * 1024;

interface Usage {
  frames: number;
  bytes: number;
}
const sockets = new WeakMap<object, Usage>();
const nodes = new Map<string, Usage>();
const total: Usage = { frames: 0, bytes: 0 };

/** Charge both dispatched writes and retained retries until their payload is released. */
export function takeInputBudget(ws: WsSocket, payload: string): (() => void) | null {
  if (ws.data.inputClosed || ws.data.accessRevoked) return null;
  const bytes = Buffer.byteLength(payload);
  const usage = sockets.get(ws.data) ?? { frames: 0, bytes: 0 };
  const nodeId = ws.data.nodeId;
  const node = nodes.get(nodeId) ?? { frames: 0, bytes: 0 };
  if (
    bytes > INPUT_FRAME_MAX_BYTES ||
    usage.frames >= INPUT_SOCKET_MAX_FRAMES ||
    usage.bytes + bytes > INPUT_SOCKET_MAX_BYTES ||
    node.frames >= INPUT_NODE_MAX_FRAMES ||
    node.bytes + bytes > INPUT_NODE_MAX_BYTES ||
    total.frames >= INPUT_GLOBAL_MAX_FRAMES ||
    total.bytes + bytes > INPUT_GLOBAL_MAX_BYTES
  ) {
    // Stop admitting work even if the close callback is delayed. Already
    // dispatched writes stay charged until they settle, including on reconnect.
    ws.data.inputClosed = true;
    try {
      ws.close(bytes > INPUT_FRAME_MAX_BYTES ? 1009 : 1013, "terminal input limit exceeded");
    } catch {
      /* already closed */
    }
    return null;
  }
  sockets.set(ws.data, usage);
  nodes.set(nodeId, node);
  node.frames++;
  node.bytes += bytes;
  usage.frames++;
  usage.bytes += bytes;
  total.frames++;
  total.bytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    node.frames--;
    node.bytes -= bytes;
    if (node.frames === 0) nodes.delete(nodeId);
    usage.frames--;
    usage.bytes -= bytes;
    total.frames--;
    total.bytes -= bytes;
    if (usage.frames === 0) sockets.delete(ws.data);
  };
}
