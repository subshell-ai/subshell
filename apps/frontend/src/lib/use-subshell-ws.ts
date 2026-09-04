import type { ServerFrame } from "@internal/subshell-protocol";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { BUILD_ID } from "@/lib/build-id";
import { sendInput, sendResize } from "@/lib/subshell-frames.js";

export interface TermWsHandlers {
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (msg: string) => void;
}

/** Fixed delay (ms) between automatic reconnect attempts. */
const RECONNECT_DELAY_MS = 1500;
/**
 * How long a `resize` request waits for its `geometry` acknowledgement before
 * being re-sent. Comfortably longer than a tmux round trip, short enough that
 * a lost request self-heals before the user notices a stale grid.
 */
const GEOMETRY_ACK_TIMEOUT_MS = 700;
/**
 * How many times to re-ask before conforming the grid to the pane instead.
 * Bounded so a pane that genuinely cannot take our size (or a server that
 * never answers) settles rather than resizing forever.
 */
const MAX_GEOMETRY_REASKS = 3;

/**
 * Attaches a WebSocket to an xterm terminal: streams server frames
 * (`replay` + `output`) into the terminal and forwards keystrokes back.
 *
 * The connection survives transient drops: after any non-rejection close the
 * hook reconnects automatically (fixed 1.5s delay) until it unmounts or the
 * server rejects the subshell. Each attach re-streams a clean snapshot: one
 * `replay` frame carries the pane grid plus a bounded window of tmux's own
 * reflowed history, and the live tail then carries ONLY output produced after
 * that snapshot — historical raw log bytes (mid-stream TUI redraw sequences)
 * are never re-played over the grid. Reconnects rebuild the terminal with no
 * client-side replay history to store; the terminal is reset on the first
 * `replay` frame of an attach so the previous connection's screen content is
 * not left behind.
 *
 * The browser's fitted geometry rides the connect URL (`cols`/`rows`) so the
 * server resizes the pane BEFORE capturing the replay — painting a grid
 * captured at a different width is what re-wraps rows into garbage.
 *
 * Auth: the better-auth session cookie is HttpOnly, and the Vite WS proxy
 * doesn't forward Cookie headers on upgrade — so we first call the
 * authenticated REST endpoint `POST /api/auth/ws-token` (the cookie works for
 * plain HTTP) and pass the returned single-use token as a query param on the
 * WS connection.
 *
 * Returns a ref of the current WebSocket (null while disconnected), so callers
 * outside the hook can inspect its `bufferedAmount` (e.g. before forwarding
 * paste input).
 */
export function useSubshellWs(
  terminalRef: { current: Terminal | null },
  subshellId: string,
  handlers: TermWsHandlers = {},
  /**
   * Read-only attach (spec 2026-08-31 §4.1): a `view` grantee watches the pane
   * but cannot type. Sets xterm `disableStdin` and drops any input that still
   * reaches the handler, so keystrokes and pastes never hit the socket.
   */
  readOnly = false,
  /**
   * Re-measures the terminal grid (fit) right before the connect URL carries
   * its `cols`/`rows`. A freshly mounted terminal can settle its layout —
   * header chrome appearing, scrollbars toggling — between the mount-time fit
   * and this async point; capturing at stale dimensions is what made rows
   * arrive mis-wrapped until the next manual resize.
   */
  measure?: () => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const inputDisposableRef = useRef<{ dispose(): void } | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !subshellId) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Geometry reconciliation state, at EFFECT scope because `term.onResize`
    // (subscribed once for the hook's lifetime) and the per-connection frame
    // handler both take part. See the block in `connect` for the why.
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let reasks = 0;
    /** True while conforming the grid to the pane, so the echo does not re-request. */
    let applyingPaneGeometry = false;
    /** The live connection's "tell the server our size" function. */
    let requestSize: (() => void) | null = null;
    const clearAckTimer = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
    };

    /**
     * Arms the next reconnect attempt. Replaces any pending timer so two
     * close paths can never stack a second attempt.
     */
    const scheduleRetry = () => {
      if (cancelled) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    };

    const connect = async () => {
      try {
        const { token } = await apiFetch<{ token: string }>("/api/auth/ws-token", { method: "POST" });
        if (cancelled) return;

        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        // Geometry at CONNECT time (re-fitted here, not just at mount): the
        // server resizes the pane to these before capturing, so the replay
        // arrives laid out for this exact terminal width.
        measure?.();
        const usedCols = term.cols;
        const usedRows = term.rows;
        // `build` is this bundle's own asset hash (see lib/build-id.ts): the
        // journal's attach line then states WHICH client code is talking, so
        // a cached PWA running pre-fix JavaScript is visible instead of being
        // mistaken for a server bug.
        const url =
          `${proto}://${window.location.host}/ws?subshell=${encodeURIComponent(subshellId)}` +
          `&token=${encodeURIComponent(token)}&cols=${usedCols}&rows=${usedRows}` +
          `&build=${encodeURIComponent(BUILD_ID)}`;

        const ws = new WebSocket(url);
        socket = ws;
        wsRef.current = ws;

        // GEOMETRY RECONCILIATION (2026-09-04). A resize used to be a
        // fire-and-forget hope: if the request was lost or overtaken, the pane
        // kept a different size than this grid, and because a diff-rendering
        // TUI positions every frame relative to the geometry it believes the
        // terminal has, every later frame landed on the wrong rows — the
        // screen froze mid-selection or filled with superimposed frames, and
        // only a reattach cleared it. The server now answers each request with
        // the pane's REAL size, so an unacknowledged or mismatched resize is
        // visible here and can simply be re-asked.
        const syncSize = () => {
          sendResize(ws, term.cols, term.rows);
          // No answer means the request never landed — ask again rather than
          // paint into a grid the pane does not share.
          clearAckTimer();
          ackTimer = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN && reasks < MAX_GEOMETRY_REASKS) {
              reasks += 1;
              syncSize();
            }
          }, GEOMETRY_ACK_TIMEOUT_MS);
        };
        reasks = 0;
        requestSize = syncSize;

        // Each attach rebuilds full history; the previous connection's screen
        // content must not stay behind (capture-pane output has no clear
        // sequence of its own), so wipe the terminal before the first replay.
        let replayStarted = false;

        ws.onopen = () => {
          handlersRef.current.onOpen?.();
          // Sync the detached tmux window to the browser terminal size
          // (tmux subshells start at 80×24; the pane must match the client).
          syncSize();
        };
        // Frames arrive DEC-2026-stripped from the backend (see
        // stripSyncMarkers in ws/sync-stripper.ts): xterm 6 withholds all
        // painting while a synchronized update is open, and the harness TUIs
        // leave one open across idle seconds — do not "restore" the markers.
        ws.onmessage = (e) => {
          try {
            const frame = JSON.parse(e.data as string) as ServerFrame;
            if (frame.type === "replay") {
              if (frame.data) {
                if (!replayStarted) {
                  term.reset();
                  replayStarted = true;
                }
                term.write(frame.data);
                // The capture was taken for the dimensions we CONNECTED with.
                // If the grid settled to a different size since (late layout,
                // scrollbar), those rows are the wrong width for the screen
                // just painted — say so immediately: the pane resizes, its
                // TUI repaints, and the corrected frames arrive over the
                // already-armed tail. Without this the mis-wrap persists
                // until the user happens to resize the window.
                if (term.cols !== usedCols || term.rows !== usedRows) syncSize();
              }
            } else if (frame.type === "output" && frame.data) {
              term.write(frame.data);
            } else if (frame.type === "geometry" && frame.cols && frame.rows) {
              // The pane's real size — the acknowledgement the retry waits on.
              clearAckTimer();
              if (frame.cols === term.cols && frame.rows === term.rows) {
                reasks = 0; // agreed: painting is coherent
              } else if (reasks < MAX_GEOMETRY_REASKS) {
                reasks += 1; // the pane took a different size — ask for ours again
                syncSize();
              } else {
                // The pane will not take our size. Conform to IT: a terminal a
                // few rows off its container still reads fine, whereas
                // painting into a mismatched grid corrupts every later frame.
                applyingPaneGeometry = true;
                try {
                  term.resize(frame.cols, frame.rows);
                } finally {
                  applyingPaneGeometry = false;
                }
              }
            }
          } catch {
            // ignore malformed frame
          }
        };
        ws.onclose = (e) => {
          // Ignore stale sockets: a superseded connection's close can arrive
          // AFTER a reconnect landed (the server closes the old socket when
          // the new attach arrives), and reporting it would clobber the
          // connected state. The current socket's close is the only one that
          // drives retries + the page's pill.
          if (wsRef.current !== ws) return;
          wsRef.current = null;
          handlersRef.current.onClose?.(e.code, e.reason);
          // 4xxx codes are the server rejecting the attach (missing subshell /
          // unauthorized / subshell not running) — retrying cannot succeed, so
          // let the page's onClose surface the dead-subshell state. Every other
          // close (1006 drop, backend restart, …) is retried.
          if (!cancelled && e.code < 4000) scheduleRetry();
        };
        ws.onerror = () => handlersRef.current.onError?.("WebSocket error");
      } catch (err) {
        handlersRef.current.onError?.(err instanceof Error ? err.message : "Failed to get WS token");
        // Token fetch failure (e.g. backend down): no socket exists to close,
        // so no onclose retry will fire — schedule the retry here.
        scheduleRetry();
      }
    };

    // A read-only viewer: xterm stops emitting stdin and the cursor hides;
    // the `readOnly` guard below is the belt to that brace (paste paths, older
    // xterm). Output still streams in — watching is the whole point.
    term.options.disableStdin = readOnly;

    // Forward terminal input to the subshell (single subscription for the hook
    // lifetime — the retry loop must not re-subscribe per connection).
    inputDisposableRef.current = term.onData((data) => {
      if (readOnly) return;
      sendInput(wsRef.current, data);
    });

    // Keep the tmux window in sync with the client terminal across resizes
    // (window changes, DevTools, fullscreen). Hooked before connect so no
    // size update is lost; the terminal emits onResize after the page's
    // ResizeObserver calls fit().
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      // A resize we applied to MATCH the pane must not be echoed back as a
      // request — that would ping-pong the pane between two sizes.
      if (applyingPaneGeometry) return;
      reasks = 0;
      // Route through the live connection's request path so the resize is
      // acknowledged (and re-asked if it goes missing); the direct send is
      // the fallback before the first connection exists.
      if (requestSize) requestSize();
      else sendResize(wsRef.current, cols, rows);
    });

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearAckTimer();
      requestSize = null;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      resizeDisposable.dispose();
      if (socket) socket.close(1000, "client detached");
      wsRef.current = null;
    };
  }, [terminalRef, subshellId, readOnly, measure]);

  return wsRef;
}
