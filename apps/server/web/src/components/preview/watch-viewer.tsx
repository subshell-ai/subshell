import { Button } from "@internal/node-admin";
import type { PreviewStreamFrame } from "@internal/subshell-protocol";
import { type JSX, useEffect, useRef, useState } from "react";
import { subscribePreview } from "@/lib/preview-bus";
import { previewJpegAllowed } from "@/lib/preview-jpeg";

/**
 * The Watch canvas: the pane's live browser frame, painted from
 * `preview-stream` frames (spec §7).
 *
 * The frame carries no wall-clock field (spec §6), so every reading here is
 * ARRIVAL-based: age is now minus the newest frame RECEIVED, and the rate is
 * the arrival spacing. That makes the badge and the staleness rule agree by
 * construction, which is the point: "no frame for 5 s reads stale" is stated
 * against the arrival clock, and the badge freezes with it. A live socket can
 * simply stop delivering - revocations are signal-free (Task 11) - and a
 * frozen page must never read as live.
 *
 * The canvas keeps the newest frame the bus delivered for THIS pane, by id.
 * A lower `seq` is an old frame arriving late (a resync, a re-subscription)
 * and painting it would rewind the picture, so it is dropped.
 */

/** What the §7 rule counts: no frame this long and the canvas is stale. */
export const STALE_MS = 5_000;

import type { PreviewConnection } from "./preview-toolbar";

export interface WatchViewerProps {
  compact?: boolean;
  onConnectionChange?: (state: PreviewConnection) => void;
  /** The pane whose screencast this canvas paints. */
  paneId: string;
  /** The pane's browser quit mid-watch (the info poll says `cdpPort: null`). */
  gone?: boolean;
  /**
   * Offered only when the browser row is gone: the row's own Watch/Stop
   * toggle left with it, so the canvas holds the stop.
   */
  onStop?: () => void;
  /** Staleness threshold. Defaults to {@link STALE_MS}; exists for the tests. */
  staleMs?: number;
  /** How often the badge/age recomputes. Defaults to 1 s; exists for the tests. */
  tickMs?: number;
}

export function WatchViewer({
  paneId,
  gone = false,
  onStop,
  compact = false,
  onConnectionChange,
  staleMs = STALE_MS,
  tickMs = 1_000,
}: WatchViewerProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef(onConnectionChange);
  connectionRef.current = onConnectionChange;
  const [frame, setFrame] = useState<PreviewStreamFrame | null>(null);
  const lastSeqRef = useRef(0);
  /** Arrival clock stamps, newest last; the age and rate read this, nothing else. */
  const arrivalsRef = useRef<number[]>([]);
  const lastSeenRef = useRef(Date.now());
  /** The badge's last LIVE reading; "frozen while stale" reads this, not a recomputation. */
  const badgeRef = useRef("0.0 fps · 0.0 s ago");
  // A tick counter: the fake clock moves only when the component LOOKS, so
  // every reading is computed during render from the refs.
  const [, setTick] = useState(0);

  useEffect(() => {
    lastSeenRef.current = Date.now();
    arrivalsRef.current = [];
    // The seq high-water mark is per-bridge, so it starts over with the pane:
    // a survived number from another pane's canvas would silently drop this
    // one's first frames. (The arrival clock above resets with the same line
    // of reasoning.)
    lastSeqRef.current = 0;
    const off = subscribePreview(paneId, (f) => {
      if (f.seq <= lastSeqRef.current) return;
      lastSeqRef.current = f.seq;
      lastSeenRef.current = Date.now();
      arrivalsRef.current = [
        ...arrivalsRef.current.filter((t) => lastSeenRef.current - t <= staleMs),
        lastSeenRef.current,
      ];
      setFrame(f);
    });
    return off;
  }, [paneId, staleMs]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);

  // Paint through the same newest-frame path the attributes carry: the Image
  // decode is async, so a newer frame can overtake an older one; the seq
  // check above already guarantees only the newest is current, and a
  // late-arriving decode would paint the frame the canvas is showing anyway.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!frame || !canvas || !previewJpegAllowed(frame.blob)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // no 2D here (test environments); the attributes still hold truth
    canvas.width = frame.w;
    canvas.height = frame.h;
    const img = new Image();
    img.onload = () => {
      // happy-dom hands out a partial 2D context (no drawImage) and fires
      // onload synchronously, so the guard keeps the test environment's
      // canvas honest without touching what a real browser does.
      if (typeof ctx.drawImage === "function") ctx.drawImage(img, 0, 0, frame.w, frame.h);
    };
    img.src = `data:image/jpeg;base64,${frame.blob}`;
    return () => {
      img.onload = null;
      img.src = "";
    };
  }, [frame]);

  const now = Date.now();
  const ageMs = Math.max(0, now - lastSeenRef.current);
  const stale = ageMs >= staleMs;
  const connection: PreviewConnection = gone
    ? "disconnected"
    : !frame
      ? "connecting"
      : stale
        ? "disconnected"
        : "connected";
  useEffect(() => {
    connectionRef.current?.(connection);
  }, [connection]);
  if (!stale) {
    const stamps = arrivalsRef.current;
    const span = stamps.length > 1 ? (stamps[stamps.length - 1] - stamps[0]) / 1_000 : 0;
    const fps = span > 0 ? (stamps.length - 1) / span : 0;
    badgeRef.current = `${fps.toFixed(1)} fps · ${(ageMs / 1_000).toFixed(1)} s ago`;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-2">
      {!compact && (
        <div className="flex w-full items-center justify-between gap-3">
          <span className="font-strong text-label">Live browser frame</span>
          {onStop && (
            <Button variant="outline" size="sm" onClick={onStop}>
              Stop
            </Button>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        data-preview-canvas=""
        data-seq={frame?.seq ?? 0}
        data-bytes={frame?.blob.length ?? 0}
        className="min-h-0 w-full max-w-full flex-1 rounded border border-border bg-background object-contain"
      />
      {/* One detail line for every clock reading, and it freezes while stale:
          a ticking age under a dead stream reads live, which is the exact lie
          the 5 s rule exists to prevent. */}
      <p data-preview-badge className="text-detail text-muted-foreground">
        {badgeRef.current}
        {stale && <span className="text-warning"> · No frame for a while. Still there?</span>}
        {gone && <span> · The browser is no longer running. No more frames will arrive.</span>}
      </p>
    </div>
  );
}
