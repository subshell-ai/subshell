import type { JSX } from "react";

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

export function OpenPanel({ port, proxyBase, reloadKey, onConnectionChange }: OpenPanelProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <iframe
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
