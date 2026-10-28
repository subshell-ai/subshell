import {
  isPreviewRefusalReason,
  PREVIEW_REFUSAL_MESSAGE,
  type PreviewRefusalReason,
} from "@internal/subshell-protocol";
import { type JSX, useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * The forwarded lane as the preview tab renders it (spec §7): the
 * `/pv/<ref>/` iframe and nothing else. The ref in `proxyBase` is the proxy's
 * only secret, minted per open under the caller's own access, so this panel is
 * just a viewer of a path that already exists. Leaving is the toolbar's
 * Close view; the lane itself is the plane's to expire.
 */

import type { PreviewConnection } from "./preview-toolbar";

export interface OpenPanelProps {
  reloadKey?: number;
  onConnectionChange?: (state: PreviewConnection) => void;
  /** The forwarded port, for the title. */
  port: number;
  /** The proxy path from `POST /views/open`, ending in a slash. */
  proxyBase: string;
}

/** What the person hears when the proxy refuses a navigation on their behalf. */
const REFUSAL_TOAST: Record<PreviewRefusalReason, { title: string; description: string }> = {
  download: {
    title: "Download kept out of the preview",
    description: "The app offered a file, which would have taken over this screen with no way back.",
  },
  "not-a-page": {
    title: "That address isn't a web page",
    description: "Close this preview and choose a website port.",
  },
};

export function OpenPanel({ port, proxyBase, reloadKey, onConnectionChange }: OpenPanelProps): JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const ref = /\/pv\/([0-9a-f]{32})\/$/.exec(proxyBase)?.[1];
    if (!ref) return;
    const onMessage = (event: MessageEvent) => {
      // The refusal page runs sandboxed with no same-origin, so its event.origin
      // reads "null" and proves nothing. What authorizes a message is that it came
      // from the window of the frame this panel created, and names this session's
      // own ref. A frame with no window cannot have posted anything, so a null on
      // either side is refused: `null === null` would believe any sender. Nothing
      // the app wrote is ever rendered; the payload carries one of two known words
      // and the sentences stay ours.
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const data = event.data as { type?: unknown; ref?: unknown; reason?: unknown } | null;
      if (!data || data.type !== PREVIEW_REFUSAL_MESSAGE || data.ref !== ref) return;
      if (!isPreviewRefusalReason(data.reason)) return;
      const copy = REFUSAL_TOAST[data.reason];
      toast.message(copy.title, { description: copy.description });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [proxyBase]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <iframe
        ref={frame}
        key={reloadKey}
        onLoad={() => onConnectionChange?.("connected")}
        sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups"
        referrerPolicy="no-referrer"
        title={`Preview of port ${port}`}
        src={proxyBase}
        className="min-h-0 w-full flex-1 bg-background"
        // The forwarded lane is the pane's own protocol; the CSP carve-out
        // for `/pv/` frames is the server's (spec §7, §8).
      />
    </div>
  );
}
