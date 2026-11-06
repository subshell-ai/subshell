import type { NodePreviewPortsResult, NodePreviewScreenWire } from "@internal/subshell-protocol";
import type { PreviewBroker } from "@/modules/previews/preview-broker.js";

/**
 * The ONE screen decision, computed from the node's ports answer exactly the
 * way `GET /api/subshells/:id/views` answers `screen`. The info route renders
 * it and the runtime-toggle guard refuses on it, so the checkbox the user
 * reads and the guard that answers it can never disagree about which display
 * is live.
 *
 * The rules the pair must keep agreeing on:
 * - the launch ack names the screen before the node's own scan reports it, so
 *   the plane's memory fills a null answer, but a reported `screenLost`
 *   outranks the memory (a death the node named beats a birth the plane
 *   remembers), and a live answer is never masked;
 * - the memory belongs to a pane only while its node matches, so a stale
 *   entry for a moved or re-created row never reads ON.
 *
 * `getPorts` is cache-backed (5 s window, joined in-flight), so neither the
 * poll nor the guard's read adds RPC burden per call.
 */
export interface LiveScreenRead {
  /** The raw ports answer, so the info route still renders `ports`, `cdpPort`, and `screenLost` off it. */
  answer: NodePreviewPortsResult;
  /** The pane's live display, or null when nothing is live as `/views` computes it. */
  screen: NodePreviewScreenWire | null;
}

/** Await the pane's ports answer and compute its live screen exactly as `/views` does. */
export async function liveScreenForPane(
  broker: PreviewBroker,
  nodeId: string,
  paneId: string,
): Promise<LiveScreenRead> {
  const answer = await broker.getPorts(nodeId, paneId);
  const remembered = answer.screen === null && answer.screenLost === undefined ? broker.displayForPane(paneId) : null;
  return {
    answer,
    screen: remembered && remembered.nodeId === nodeId ? remembered.screen : answer.screen,
  };
}
