import { type PreviewStreamFrame, previewImageSizeAllowed } from "@internal/subshell-protocol";

/**
 * The pane-keyed screencast bus between the ONE live socket and the viewers.
 *
 * `/ws/live` is a single socket per tab, and a `preview-stream` frame carries
 * only the pane's id — the socket cannot know which pane the tab is watching,
 * and the feed must not re-render the whole tree for a JPEG nobody asked for.
 * So the feed publishes each frame here and the viewer subscribes by pane;
 * delivery is a map lookup, not a React pass. Frames carry no wall-clock
 * field (spec §6), so nothing here can be read as a timestamp — age is the
 * viewer's own arrival clock's business.
 */

const byPane = new Map<string, Set<(frame: PreviewStreamFrame) => void>>();

/**
 * Receive every screencast frame for one pane until the returned function is
 * called. Subscribing twice delivers twice; unsubscribing twice is a no-op.
 */
export function subscribePreview(paneId: string, cb: (frame: PreviewStreamFrame) => void): () => void {
  let set = byPane.get(paneId);
  if (!set) {
    set = new Set();
    byPane.set(paneId, set);
  }
  set.add(cb);
  return () => {
    const live = byPane.get(paneId);
    if (!live) return;
    live.delete(cb);
    // An empty room leaves no trace: the map only ever holds watched panes.
    if (live.size === 0) byPane.delete(paneId);
  };
}

/**
 * Hand one frame to the panes' viewers. A subscriber that throws must not
 * starve the others — the feed's `onmessage` is what calls this, and an
 * uncaught error there costs every frame after it, for every pane.
 */
export function publishPreviewFrame(frame: PreviewStreamFrame): void {
  if (!previewImageSizeAllowed(frame.w, frame.h, frame.blob)) return;
  const set = byPane.get(frame.id);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(frame);
    } catch {
      // The viewer's render is broken, not the stream. Drop the failure.
    }
  }
}
