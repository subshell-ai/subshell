import {
  type ClientFrame,
  normalizeDeviceLabel,
  type ServerFrame,
  type ViewersState,
} from "@internal/subshell-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubshellClient } from "@/lib/api";
import { wsOrigin } from "@/lib/instance-url";

/** Fixed reconnect delay — same as the web hook (`use-subshell-ws.ts:14`). */
export const RECONNECT_DELAY_MS = 1500;

/**
 * 4xxx = server rejection (attach failed / unauthorized / not running):
 * retrying cannot succeed. Everything below is a transient drop. Mirrors
 * `apps/server/web/src/lib/use-subshell-ws.ts` close handling.
 */
export function shouldReconnectAfterClose(code: number): boolean {
  return code < 4000;
}

/** Used when the caller names no device. */
export const DEFAULT_DEVICE_LABEL = "Subshell app";

/** Live status for the detail pill/banner (spec §Error handling). */
export type SocketStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "closed"; code: number }
  | { state: "rejected"; code: number };

/** Frame sink: what the socket hands to the renderer (Task 8's WebView). */
export interface SubshellSocketHandlers {
  /** One pane-write chunk (replay tail or live output). */
  onBytes: (data: string) => void;
  /** First replay of a fresh attach: wipe the emulator (spec §Transport). */
  onReset: () => void;
}

/**
 * One socket, one subshell (spec §Transport): the single-use token is minted
 * per connect AND per reconnect (30 s TTL). Frames are JSON text — the web
 * contract unchanged (invariant 3). RN owns the socket; the WebView never
 * sees it. Status is returned, not duplicated through a handler — one source
 * per value (review, simplification #2).
 */
export function useSubshellSocket(opts: {
  client: SubshellClient;
  subshellId: string;
  active: boolean;
  handlers: SubshellSocketHandlers;
  /**
   * Names this device in the shared-viewers list. A subshell can be open on a
   * phone and a laptop at once, and the pane is sized to the smaller of them.
   * Passed in rather than read from `Platform` here: this module is covered by
   * the pure `bun test` suite, and importing `react-native` drags Flow syntax
   * into it that the runner cannot parse.
   */
  deviceLabel?: string;
  /**
   * True while the app is not in the foreground.
   *
   * The pane is sized to the smallest VISIBLE viewer, so a phone left
   * attached in a pocket would otherwise hold every laptop watching the same
   * subshell at phone size, with nothing on either screen to explain it. The
   * socket deliberately stays open while backgrounded (push and the badge
   * are the point of this app), so being attached cannot mean "watching".
   *
   * Passed in rather than read from `AppState` here: this module is covered
   * by the pure `bun test` suite, and importing `react-native` drags Flow
   * syntax into it that the runner cannot parse.
   */
  hidden?: boolean;
}) {
  const { client, subshellId, active } = opts;
  const hidden = opts.hidden === true;
  const handlersRef = useRef(opts.handlers);
  handlersRef.current = opts.handlers;
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Read by `onopen`, which is created once per connect and must not capture
  // a stale value across a backgrounding that happened mid-handshake.
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [status, setStatus] = useState<SocketStatus>({ state: "connecting" });
  /**
   * Who else is watching, straight off the socket. Null while it is down —
   * presence is live state, not a cache, and a phone that keeps claiming two
   * devices through a reconnect is lying about the thing it is there to
   * explain.
   */
  const [viewers, setViewers] = useState<ViewersState | null>(null);

  const frame = useCallback((f: ClientFrame) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }, []);

  /** Raw keystroke bytes for the pane; no-op while not open (like the web sendInput). */
  const sendInput = useCallback(
    (data: string) => {
      if (data) frame({ type: "input", data });
    },
    [frame],
  );

  /**
   * Chooses how the pane is sized while several devices watch it: `auto`
   * hands it to the smallest visible one, `pinned` to the named viewer.
   * Refused server-side for a `view` grantee — sizing changes what everyone
   * sees, so it is an `edit` act like typing.
   */
  const setSizing = useCallback(
    (mode: "auto" | "pinned", viewerId?: string | null) => {
      frame({ type: "set-sizing", mode, viewerId: viewerId ?? null });
    },
    [frame],
  );

  /** Tells tmux the fitted geometry; re-sent on every fresh open. */
  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      sizeRef.current = { cols, rows };
      frame({ type: "resize", cols, rows });
    },
    [frame],
  );

  // Re-announce when the app moves between foreground and background. The
  // socket outlives that transition, so nothing else would tell the server.
  useEffect(() => {
    frame({ type: "visibility", hidden });
  }, [frame, hidden]);

  useEffect(() => {
    if (!active || !subshellId) return;
    let cancelled = false;

    const scheduleRetry = () => {
      if (cancelled) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    };

    async function connect() {
      if (cancelled) return;
      setStatus({ state: "connecting" });
      try {
        const { token } = await client.wsToken(); // mint per attempt, never reused
        if (cancelled) return;
        // Geometry rides the URL, exactly as the web client does: the server
        // resizes the pane to it BEFORE capturing the replay, so the snapshot
        // arrives laid out for this screen. Without it the pane was captured
        // at whatever size it happened to hold — tmux births windows at 80x24
        // — and the phone painted a grid that was never its own. The attach
        // journal called this out as `geometry MISSING`.
        const fitted = sizeRef.current;
        const geometry = fitted ? `&cols=${fitted.cols}&rows=${fitted.rows}` : "";
        // Names this device in the shared-viewers list; a subshell can be open
        // on a phone and a laptop at once, and the pane is sized to the
        // smaller of them.
        const device = `&device=${encodeURIComponent(normalizeDeviceLabel(opts.deviceLabel ?? "") || DEFAULT_DEVICE_LABEL)}`;
        // `hidden` rides the URL as well as the on-open frame: that frame
        // races the server's own attach awaits and is DROPPED when it wins,
        // and nothing re-sends it until the app is foregrounded again. A
        // reconnect while pocketed would otherwise count as a visible viewer
        // for the socket's whole life, holding every laptop's pane at phone
        // size — the exact failure the frame was added to prevent.
        const url = `${wsOrigin(client.baseUrl)}/ws?subshell=${encodeURIComponent(subshellId)}&token=${encodeURIComponent(token)}${geometry}${device}&hidden=${hiddenRef.current ? "1" : "0"}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        let replayStarted = false;
        ws.onopen = () => {
          if (cancelled || wsRef.current !== ws) return;
          setStatus({ state: "open" });
          // State, not an event: an app attached while already backgrounded
          // must say so, or it silently shrinks every other device's pane.
          ws.send(JSON.stringify({ type: "visibility", hidden: hiddenRef.current } satisfies ClientFrame));
          const s = sizeRef.current; // sync tmux to the fitted terminal (80×24 default)
          if (s) ws.send(JSON.stringify({ type: "resize", cols: s.cols, rows: s.rows } satisfies ClientFrame));
        };
        ws.onmessage = (e) => {
          if (cancelled || wsRef.current !== ws) return;
          try {
            const f = JSON.parse(String(e.data)) as ServerFrame;
            if (f.type === "replay" && f.data) {
              if (!replayStarted) {
                handlersRef.current.onReset(); // full history per attach — wipe first
                replayStarted = true;
              }
              handlersRef.current.onBytes(f.data);
            } else if (f.type === "output" && f.data) {
              handlersRef.current.onBytes(f.data);
            } else if (f.type === "viewers") {
              setViewers({ you: f.you, viewers: f.viewers, sizing: f.sizing });
            }
          } catch {
            /* malformed frame: ignore, like the web client */
          }
        };
        ws.onclose = (ev) => {
          if (wsRef.current !== ws) return; // superseded socket's late close
          wsRef.current = null;
          // RN's CloseEvent types code as optional; 1006 (abnormal closure) is
          // what a dropped socket reports.
          const code = ev.code ?? 1006;
          setViewers(null); // with the socket down we do not know who is watching
          if (shouldReconnectAfterClose(code)) {
            setStatus({ state: "closed", code });
            scheduleRetry();
          } else {
            setStatus({ state: "rejected", code });
          }
        };
        ws.onerror = () => {
          /* onclose always follows and drives the policy */
        };
      } catch {
        if (cancelled) return;
        setStatus({ state: "closed", code: 0 }); // token mint failed — no socket to close
        scheduleRetry();
      }
    }

    void connect();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.close();
      } catch {
        /* already dead */
      }
    };
  }, [client, subshellId, active, opts.deviceLabel]);

  return { sendInput, sendResize, setSizing, status, viewers };
}
