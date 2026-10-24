import { Button, cn } from "@internal/node-admin";
import { ExternalLink, X } from "lucide-react";
import type { JSX } from "react";

/**
 * The collapsible side panel one forwarded lane lives in (spec §7): the
 * `/pv/<ref>/` iframe itself, plus the escape hatch. The ref in `proxyBase`
 * is the proxy's only secret, minted per open under the caller's own access,
 * so this panel is just a viewer of a path that already exists.
 */

import type { PreviewConnection } from "./preview-toolbar";

export interface OpenPanelProps {
  compact?: boolean;
  reloadKey?: number;
  onConnectionChange?: (state: PreviewConnection) => void;
  /** The forwarded port, for the title. */
  port: number;
  /** The proxy path from `POST /preview/open`, ending in a slash. */
  proxyBase: string;
  /** Collapse the panel. The lane itself is the plane's to expire. */
  onClose: () => void;
}

export function OpenPanel({
  port,
  proxyBase,
  onClose,
  compact = false,
  reloadKey,
  onConnectionChange,
}: OpenPanelProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-background",
        !compact && "gap-2 rounded-md border border-border p-3",
      )}
    >
      {!compact && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <span className="font-strong text-label">App preview</span>
          <span className="text-detail text-muted-foreground">Port {port}</span>
          <div className="flex items-center gap-1">
            <a
              href={proxyBase}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-detail text-primary hover:underline"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              Open in new tab
            </a>
            <Button variant="ghost" size="sm" aria-label="Close preview panel" onClick={onClose}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
      <iframe
        key={reloadKey}
        onLoad={() => onConnectionChange?.("connected")}
        sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups"
        referrerPolicy="no-referrer"
        title={`Preview of port ${port}`}
        src={proxyBase}
        className={cn("min-h-0 w-full flex-1 bg-background", !compact && "rounded border border-border")}
        // The forwarded lane is the pane's own protocol; the CSP carve-out
        // for `/pv/` frames is the server's (spec §7, §8).
      />
    </div>
  );
}
