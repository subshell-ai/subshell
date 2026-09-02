import type { ClientFrame, ServerFrame } from "@internal/session-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubshellClient } from "@/lib/api";
import { wsOrigin } from "@/lib/instance-url";

/** Fixed reconnect delay — same as the web hook (`use-session-ws.ts:14`). */
export const RECONNECT_DELAY_MS = 1500;

/**
 * 4xxx = server rejection (attach failed / unauthorized / not running):
 * retrying cannot succeed. Everything below is a transient drop. Mirrors
 * `apps/frontend/src/lib/use-session-ws.ts` close handling.
 */
export function shouldReconnectAfterClose(code: number): boolean {
  return code < 4000;
}

/** Live status for the detail pill/banner (spec §Error handling). */
export type SocketStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "closed"; code: number }
  | { state: "rejected"; code: number };

/** Frame sink: what the socket hands to the renderer (Task 8's WebView). */
export interface SessionSocketHandlers {
  /** One pane-write chunk (replay tail or live output). */
  onBytes: (data: string) => void;
  /** First replay of a fresh attach: wipe the emulator (spec §Transport). */
  onReset: () => void;
}

/**
 * One socket, one session (spec §Transport): the single-use token is minted
 * per connect AND per reconnect (30 s TTL). Frames are JSON text — the web
 * contract unchanged (invariant 3). RN owns the socket; the WebView never
 * sees it. Status is returned, not duplicated through a handler — one source
 * per value (review, simplification #2).
 */
export function useSessionSocket(opts: {
  client: SubshellClient;
  sessionId: string;
  active: boolean;
  handlers: SessionSocketHandlers;
}) {
  const { client, sessionId, active } = opts;
  const handlersRef = useRef(opts.handlers);
  handlersRef.current = opts.handlers;
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [status, setStatus] = useState<SocketStatus>({ state: "connecting" });

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

  /** Tells tmux the fitted geometry; re-sent on every fresh open. */
  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      sizeRef.current = { cols, rows };
      frame({ type: "resize", cols, rows });
    },
    [frame],
  );

  useEffect(() => {
    if (!active || !sessionId) return;
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
        const url = `${wsOrigin(client.baseUrl)}/ws?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        let replayStarted = false;
        ws.onopen = () => {
          if (cancelled || wsRef.current !== ws) return;
          setStatus({ state: "open" });
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
  }, [client, sessionId, active]);

  return { sendInput, sendResize, status };
}
