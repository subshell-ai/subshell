import { Button } from "@internal/node-admin";
import type { PreviewCloseReason } from "@internal/subshell-protocol";
import RFB from "@novnc/novnc";
import { type JSX, useEffect, useRef, useState } from "react";

/**
 * The Screen viewer: noVNC's RFB canvas over a pane's raw forward lane
 * (spec §6, §7). The lane came from `POST /preview/open` against the pane's
 * `rfbPort`, and decision 6 made that session `raw`, so the bytes pumped
 * under the session's proxy path are plain RFB. The ref inside `proxyBase`
 * is the whole credential: the lane and the plane's grant check are the
 * authentication (spec §5), so no VNC password is ever typed or stored.
 *
 * The component owns the WebSocket and hands the SOCKET to RFB, not the URL,
 * and that is the load-bearing choice. rfb.js 1.7.0 accepts a live socket in
 * the constructor (core/rfb.js:95-113); on the URL form RFB owns the socket
 * and its host-facing `disconnect` detail carries only `{ clean }`
 * (core/rfb.js:943-945, with the steady-state close handler reading
 * `e.code`/`e.reason` into a message it then discards at :665-669). pv-ws's
 * close shape (Task 10) is code 1011 with the `PreviewCloseReason` word
 * verbatim in the reason field, so only a close listener THIS file attaches
 * can see the word. Everything else would render every named cause as a
 * generic loss, inverting spec §9's "tells it why".
 */

/** One screen session's tunnel root: pv-ws serves any suffix under the path. */
function tunnelUrl(proxyBase: string): string {
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${window.location.host}${proxyBase}`;
}

/**
 * The human line per close word (spec §9): each cause reads as itself.
 *
 * `over-cap` has two paths, and they arrive differently. The byte ones ride
 * this word: the node's pump guard kills the lane when a framebuffer read
 * crosses `PREVIEW_FRAME_MAX_BYTES` (forward.ts), and the plane drops a
 * session when a browser message comes in oversized (preview-broker); both
 * reach the listener as pv-ws's 1011 + the word. The lane-COUNT refusal never
 * does: pv-ws answers it at the UPGRADE with a 503, and a refused upgrade
 * closes the socket with nothing on it, landing in the lost-link fallback.
 */
export const SCREEN_CLOSE_LINES: Record<PreviewCloseReason, string> = {
  "viewer-left": "You closed this preview.",
  "pane-gone": "The subshell ended, so its screen went with it.",
  "node-dropped": "The node dropped its link to the server, so this preview ended.",
  "slow-link": "This preview couldn't keep up with the pane's screen, so it closed.",
  "over-cap": "The pane's screen produced data bigger than a preview lane can carry, so this preview closed.",
  idle: "This preview sat unused, so it closed.",
  revoked: "Your access to this subshell changed, so the preview closed.",
  "not-cdp": "That port doesn't speak the protocol this preview needs.",
  "target-gone": "The screen behind this preview stopped answering.",
};

/** The line for a close that carried no word and was not ours to start. */
export const LOST_LINK_LINE = "The preview link closed before it could finish. Open Screen again for a new one.";

export interface ScreenViewerProps {
  /** The pane's virtual display, shown in the header. */
  display: string;
  /** The proxy path from `POST /preview/open`, ending in a slash. Mount-scoped: the panel keys this viewer on it. */
  proxyBase: string;
  /** Collapse the panel. The socket closes with the unmount either way. */
  onClose: () => void;
}

export function ScreenViewer({ display, proxyBase, onClose }: ScreenViewerProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // True only when the USER chose to leave (the Disconnect path). pv-ws never
  // rides a reason word on the viewer's own leave, so this flag is what
  // separates `viewer-left` from a link that died unattributed (a refused
  // upgrade, a dropped connection): the cause, not the absence of a word,
  // decides. The effect's cleanup must NOT set it: main.tsx wraps the app in
  // StrictMode, whose dev double-invoke runs a cleanup while the component
  // lives, and a ref set there would outlive the socket it was meant to mark.
  const leftRef = useRef(false);
  const [endLine, setEndLine] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(tunnelUrl(proxyBase));
    wsRef.current = ws;
    // This effect's own disposal flag. Its close (a real unmount, or
    // StrictMode's simulated one) is not a cause the viewer has to report:
    // on a real unmount nothing is left to render, and under StrictMode the
    // line burned by the discarded socket would stand in for every later,
    // genuine close.
    let disposed = false;
    const onSocketClose = (event: CloseEvent): void => {
      if (disposed) return;
      if (leftRef.current) setEndLine(SCREEN_CLOSE_LINES["viewer-left"]);
      else {
        // Every protocol word has a line; anything else on the close (junk,
        // or the wordless refused-upgrade shape) is an unattributed link loss.
        const line = (SCREEN_CLOSE_LINES as Partial<Record<PreviewCloseReason, string>>)[
          event.reason as PreviewCloseReason
        ];
        setEndLine(line ?? LOST_LINK_LINE);
      }
    };
    ws.addEventListener("close", onSocketClose);
    const host = hostRef.current;
    const rfb = host ? new RFB(host, ws) : undefined;
    if (rfb) {
      // Fit the pane's screen to the panel, take keyboard focus on click,
      // and scroll rather than clip whatever the pane drew outside the box.
      rfb.scaleViewport = true;
      rfb.focusOnClick = true;
      rfb.clipViewport = false;
    }
    return () => {
      disposed = true;
      rfb?.disconnect();
      // Closing here is the lane's `viewer-left`. `rfb.disconnect()` runs on
      // a timer of its own, so the socket does not wait for it.
      ws.close();
      wsRef.current = null;
    };
  }, [proxyBase]);

  function handleDisconnect(): void {
    // The user's own close: the flag makes the arriving wordless close say
    // `viewer-left`, which is exactly what the lane books for it.
    leftRef.current = true;
    wsRef.current?.close();
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-label">Virtual display {display}</span>
        {endLine === null ? (
          <Button variant="outline" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
      {endLine !== null ? (
        <p className="text-detail text-muted-foreground">{endLine}</p>
      ) : (
        <div ref={hostRef} className="h-[60vh] w-full overflow-auto rounded border border-border bg-background" />
      )}
    </div>
  );
}
