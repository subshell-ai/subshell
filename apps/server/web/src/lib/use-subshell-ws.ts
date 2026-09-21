import { apiFetch } from "@internal/node-admin";
import type { ServerFrame, ViewersState } from "@internal/subshell-protocol";
import { decodeFrame } from "@internal/subshell-protocol/wire";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { BUILD_ID } from "@/lib/build-id";
import { deviceName } from "@/lib/device-name";
import { createInputQueue, type InputQueue } from "@/lib/input-queue";
import { createMotionThrottle, type MotionThrottle } from "@/lib/mouse-motion-throttle";
import { motionSampleIntervalMs } from "@/lib/mouse-sampling-pref";
import { markCborSocket, sendInput, sendResize, sendVisibility } from "@/lib/subshell-frames.js";
import { dropBrokenMouseReports } from "@/lib/terminal-input";

export interface TermWsHandlers {
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (msg: string) => void;
  /**
   * The pane's REAL grid, as read back from tmux (see the `geometry` server
   * frame). This is a statement of fact, not a request: the caller renders
   * this grid and must NOT answer by asking for a different size — that is
   * the feedback loop eee3a92 reverted. Never fires for panes whose size
   * cannot be read (remote nodes), leaving those clients sizing themselves
   * exactly as before.
   */
  onGeometry?: (cols: number, rows: number) => void;
  /**
   * Who else is watching, pushed on every join, leave, resize and visibility
   * change. Every device constrains the pane's one grid, so this is the only
   * answer to "why is my terminal this size?" — a caller that renders no
   * device UI simply omits it.
   */
  onViewers?: (state: ViewersState) => void;
}

/** Fixed delay (ms) between automatic reconnect attempts. */
const RECONNECT_DELAY_MS = 1500;

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
 * Input is idempotent when the server advertises it (spec 2026-09-21 Wave A):
 * the `viewers` frame's `inputAcks` flag engages a per-subshell retry queue,
 * every keystroke then carries an id, and unacked ids are re-sent in order on
 * each reconnect (the server's completed-write window absorbs the ones that
 * already landed). Without the flag (an older server) the queue stays
 * dormant and keystrokes go bare, exactly as they always did. Input typed
 * before that answer — the window between `onopen` and the `viewers` frame —
 * is buffered by the queue and shipped when the answer lands (with ids when
 * acks engage, bare otherwise) instead of being dropped. The retry
 * re-send waits for the connection's FIRST SERVER FRAME, not `onopen`: the
 * server drops input frames that arrive before its attach handler has
 * assigned `ws.data`, and both attach paths emit their first frame only after
 * that assign.
 *
 * Every connection negotiates the CBOR wire (spec 2026-09-21 Wave B): the
 * attach URL carries `&enc=cbor`, frames are sent as CBOR binary, and the
 * server answers all frames as CBOR bytes. Negotiation is per-connection (the
 * URL decided it), so an older server that ignores the param answers JSON
 * both ways and the same two code paths read that untouched.
 *
 * Returns refs of the current WebSocket (null while disconnected, so callers
 * outside the hook can inspect its `bufferedAmount`, e.g. before forwarding
 * paste input) and of the attach's input queue (null while detached), through
 * which callers that inject text also route their bytes.
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
  /**
   * The grid this viewport could show at the current font size.
   *
   * Used for the connect URL and the on-open sync INSTEAD of `term.cols`/
   * `term.rows`, because those are no longer a measure of the viewport: the
   * caller pins the terminal's container to the grid the server last
   * announced, so reading the terminal back would echo the server's own
   * answer. That echo strands a client that resized while the socket was
   * down — it reconnects announcing the stale grid, the server obligingly
   * resizes the pane to it, and nothing ever corrects it because the pinned
   * container never changes and its ResizeObserver never ticks.
   *
   * Returns null before the terminal has cell metrics, or for callers that do
   * not pin (remote panes), in which case the terminal's own grid is used —
   * exactly the pre-pinning behavior.
   */
  capacity?: () => { cols: number; rows: number } | null,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const inputDisposableRef = useRef<{ dispose(): void } | null>(null);
  const motionRef = useRef<MotionThrottle | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const capacityRef = useRef(capacity);
  capacityRef.current = capacity;
  // The attach's input queue and the session id naming it on the connect URL.
  // `owned` remembers which subshell the queue belongs to, so a caller that
  // repoints the terminal at another subshell gets a fresh queue (fresh
  // session, ids from 1) rather than carrying ids across panes.
  const ownedQueueRef = useRef<{ subshellId: string; sessionId: string; queue: InputQueue } | null>(null);
  const inputQueueRef = useRef<InputQueue | null>(null);
  // True once the CURRENT connection has delivered its first server frame.
  // Input is sent (and re-sent) only while this is up: earlier frames are
  // dropped by the server's own attach guard, so sending into that window
  // would be silently discarding the keystrokes the queue exists to save.
  const attachLiveRef = useRef(false);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !subshellId) {
      // Detached: nothing to attach, and the caller must not keep injecting
      // into the previous attach's queue.
      inputQueueRef.current = null;
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Per-attach input queue (spec 2026-09-21 Wave A). Recreated only when the
    // SUBSHELL changes: a reconnect or a terminal rebuild on the same subshell
    // must keep counting ids and keep the same session, or the server's
    // per-session dedupe window could never absorb a retry. The sender reads
    // the live socket and the live-attach flag at call time, so one sender
    // serves every connection.
    const existing = ownedQueueRef.current;
    const reused = existing?.subshellId === subshellId;
    const sessionId = reused ? existing.sessionId : crypto.randomUUID();
    const queue = reused
      ? existing.queue
      : createInputQueue((data, id) => {
          if (!attachLiveRef.current) return false;
          sendInput(wsRef.current, data, id);
          return true;
        });
    ownedQueueRef.current = { subshellId, sessionId, queue };
    inputQueueRef.current = queue;

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
        // Capacity, not the terminal's own grid — see the `capacity` param.
        // At CONNECT there is no socket yet, so silence is not an option —
        // the URL must carry something. A pinning caller that cannot measure
        // falls back to the terminal's grid here and only here, because at
        // this instant that grid is the previous connection's, not an echo of
        // a live server answer, and the first observer tick corrects it.
        const fitted = capacityRef.current?.() ?? null;
        const usedCols = fitted?.cols ?? term.cols;
        const usedRows = fitted?.rows ?? term.rows;
        // `build` is this bundle's own asset hash (see lib/build-id.ts): the
        // journal's attach line then states WHICH client code is talking, so
        // a cached PWA running pre-fix JavaScript is visible instead of being
        // mistaken for a server bug.
        // `device` names this browser in everyone else's Devices list. Without
        // it every row reads "Unnamed device", which is worse than no list at
        // all: two identical rows cannot be told apart, so neither the pane's
        // size nor the pin control means anything (seen live, 2026-09-04).
        const url =
          `${proto}://${window.location.host}/ws?subshell=${encodeURIComponent(subshellId)}` +
          `&token=${encodeURIComponent(token)}&cols=${usedCols}&rows=${usedRows}` +
          `&build=${encodeURIComponent(BUILD_ID)}&device=${encodeURIComponent(deviceName())}` +
          // `hidden` rides the URL as well as the on-open frame: that frame
          // races the server's own attach awaits and is DROPPED if it wins,
          // and unlike a resize nothing re-sends it until the tab is shown.
          // A tab attached while already hidden would then hold every other
          // device's pane at its size for the socket's whole life.
          `&hidden=${document.hidden ? "1" : "0"}` +
          // This page's input-retry session (spec 2026-09-21 Wave A): the key
          // the server namespaces its dedupe window by. Constant across this
          // attach's reconnects, fresh on the next page load, and sent even
          // before the queue is engaged so the ids it later carries are always
          // windowed under it.
          `&sid=${encodeURIComponent(ownedQueueRef.current?.sessionId ?? "")}` +
          // Negotiate the CBOR wire (spec 2026-09-21 Wave B): every frame this
          // connection exchanges is then CBOR binary. A server older than the
          // negotiation ignores the param and answers JSON both ways, which
          // is exactly what the fallback below reads. Negotiation is
          // per-connection: the URL decided it, so a reconnect can fall back
          // cleanly and no page-level state carries the answer across
          // sockets.
          `&enc=cbor`;

        const ws = new WebSocket(url);
        socket = ws;
        wsRef.current = ws;
        // Binary frames arrive as ArrayBuffers, not Blobs, so the decoder
        // below reads bytes directly.
        ws.binaryType = "arraybuffer";
        // Every frame this socket sends rides the CBOR encoder (see
        // `subshell-frames.ts`). Per-connection: a socket created without the
        // negotiation would never be marked.
        markCborSocket(ws);

        // The one place this client states its size. A caller that PINS
        // reports only what it measured: `capacity()` returning null means
        // "I could not measure right now" (mid-layout, no cell metrics), and
        // answering that with `term.cols` would report the server's own grid
        // straight back — the echo that strands the pane at the smallest
        // viewer's size forever. Silence is correct; the next observer tick
        // reports the real number.
        const syncSize = () => {
          const provider = capacityRef.current;
          if (!provider) {
            sendResize(ws, term.cols, term.rows); // no pinning: the grid IS the viewport
            return;
          }
          const fit = provider();
          if (fit) sendResize(ws, fit.cols, fit.rows);
        };

        // Each attach rebuilds full history; the previous connection's screen
        // content must not stay behind (capture-pane output has no clear
        // sequence of its own), so wipe the terminal before the first replay.
        let replayStarted = false;

        ws.onopen = () => {
          handlersRef.current.onOpen?.();
          // State, not an event: a tab attached while hidden must say so, or
          // it silently constrains every other device's pane.
          sendVisibility(ws, document.hidden);
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
            // One decoder for both wire modes (spec 2026-09-21 Wave B): the
            // negotiated connection's frames arrive as CBOR ArrayBuffers, an
            // un-negotiated one's (an older server) as JSON strings, and
            // decodeFrame reads either. A malformed frame throws here and is
            // ignored below, exactly as a malformed JSON frame always was.
            const frame = decodeFrame(
              e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : (e.data as string),
            ) as ServerFrame;
            // The FIRST frame of a connection proves the attach has assigned
            // ws.data on the server (both the replay and the viewers broadcast
            // leave the attach handler), so it is the earliest point an input
            // frame is guaranteed to be served. The retry flush waits for it:
            // re-sending at `onopen` would feed keys into the window the
            // server's own attach guard silently drops.
            if (!attachLiveRef.current) {
              attachLiveRef.current = true;
              inputQueueRef.current?.resendPending();
            }
            if (frame.type === "ack") {
              inputQueueRef.current?.ack(frame.id);
              return;
            }
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
            } else if (frame.type === "viewers") {
              // Engagement is the server's OWN answer, re-learned per attach:
              // a flag engages tracking; its absence disengages and drops the
              // backlog, because a server that never acks turns every re-send
              // into a duplicate write. Downgrades stop retrying, they do not
              // wedge the queue against ids that will never be retired.
              const inputQueue = inputQueueRef.current;
              if (inputQueue) frame.inputAcks === true ? inputQueue.engage() : inputQueue.disengage();
              handlersRef.current.onViewers?.({ you: frame.you, viewers: frame.viewers, sizing: frame.sizing });
            } else if (frame.type === "geometry") {
              // Fact, not a request — the caller pins its grid to this and
              // stays silent about it (see TermWsHandlers.onGeometry).
              handlersRef.current.onGeometry?.(frame.cols, frame.rows);
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
          // The next connection must earn its own first frame before input is
          // sent again: the server's attach guard drops the early ones.
          attachLiveRef.current = false;
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
    // Pointer MOTION is sampled rather than forwarded frame for frame. Each
    // chunk here becomes one WS frame and then one `tmux send-keys` — a
    // process spawn, serialized per pane — so a moving pointer over a
    // mouse-reporting TUI can ask for dozens a second and queue real
    // keystrokes behind them (reported live, 2026-09-20). Nothing but motion
    // is ever delayed, and the pending motion is flushed before whatever
    // follows it, so input order is untouched.
    // Read per ATTACH rather than captured once: the preference is per device
    // and a change takes effect on the next terminal a person opens, without
    // a reload.
    // The one input entry point for everything xterm emits. Engaged, the queue
    // tracks the chunk for retry; not engaged, the chunk goes bare when the
    // pipe is live and waits in the queue's pre-engage buffer when it is not;
    // detached, it goes bare with no queue, as always. Sits AFTER the
    // mouse-report filter below, at the send boundary.
    const sendTyped = (data: string): void => {
      const inputQueue = inputQueueRef.current;
      if (inputQueue) inputQueue.enqueue(data);
      else sendInput(wsRef.current, data);
    };
    const motion = createMotionThrottle(sendTyped, motionSampleIntervalMs());
    motionRef.current = motion;
    inputDisposableRef.current = term.onData((data) => {
      if (readOnly) return;
      // Not everything xterm emits is usable: a flick's MOMENTUM frames become
      // mouse reports with NaN coordinates (see lib/terminal-input.ts), which
      // the harness prints at its prompt. Filtering here, at the one place
      // xterm's own output becomes pane input, leaves the key bar and the
      // upload injection — which cannot produce these — untouched.
      const clean = dropBrokenMouseReports(data);
      if (!clean) return;
      motion.push(clean);
    });

    // Keep the tmux window in sync with the client across resizes (window
    // changes, DevTools, fullscreen). Hooked before connect so no size update
    // is lost; the terminal emits onResize after the page's ResizeObserver
    // calls fit().
    //
    // CAPACITY, not the terminal's grid, whenever the caller pins. A pinning
    // caller sizes its container to the grid the server announced, FitAddon
    // then measures that box, and the terminal resizes to the server's own
    // answer — so forwarding `cols`/`rows` here reports the server's number
    // back as this viewer's capacity. With one viewer that is a harmless
    // no-op, which is why it survived; with two it is fatal. Measured live
    // (2026-09-04): a 77x29 laptop reported 50x18 seconds after a 50x18 phone
    // attached, and because the laptop then genuinely claimed it could show
    // no more, the pane never grew back when the phone left — a third viewer
    // at 90x30 was still handed 50x18.
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const provider = capacityRef.current;
      if (!provider) {
        sendResize(wsRef.current, cols, rows);
        return;
      }
      // A null measurement is NOT a reason to fall back to `cols`/`rows`:
      // those are the echo this whole handler exists to avoid, and a
      // momentarily unmeasurable box (a sash mid-drag) would reintroduce it.
      const fit = provider();
      if (fit) sendResize(wsRef.current, fit.cols, fit.rows);
    });

    // A viewer that stops being rendered stops taking part in sizing, and
    // rejoins the moment it is shown.
    const onVisibility = () => sendVisibility(wsRef.current, document.hidden);
    document.addEventListener("visibilitychange", onVisibility);

    void connect();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      // Flushes whatever motion was pending, so a detach cannot strand the
      // pane at a position the pointer had already left.
      motionRef.current?.dispose();
      motionRef.current = null;
      resizeDisposable.dispose();
      if (socket) socket.close(1000, "client detached");
      wsRef.current = null;
      attachLiveRef.current = false;
      inputQueueRef.current = null;
    };
  }, [terminalRef, subshellId, readOnly, measure]);

  return { wsRef, inputQueueRef };
}
