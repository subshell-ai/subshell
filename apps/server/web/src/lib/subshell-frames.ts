import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, type ClientFrame } from "@internal/subshell-protocol";

/** Serializes and sends a frame when the socket is open; a no-op otherwise. */
function send(ws: WebSocket | null, frame: ClientFrame): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

/**
 * Sends raw terminal bytes to the subshell.
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param data - Exact bytes for the pane's process; sent unmodified
 */
export function sendInput(ws: WebSocket | null, data: string): void {
  if (!data) return;
  send(ws, { type: "input", data });
}

/**
 * Tells the subshell to resize its tmux window to the client geometry.
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param cols - Terminal width in columns
 * @param rows - Terminal height in rows
 */
export function sendResize(ws: WebSocket | null, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return;
  send(ws, { type: "resize", cols, rows });
}

/**
 * Injects text into the subshell as if the user had pasted it.
 *
 * When the remote has enabled bracketed paste (DECSET 2004) the text is
 * wrapped in paste markers. This matters for injected file paths: they begin
 * with "/", which Claude Code reads as the start of a slash command when it
 * arrives as keystrokes. Wrapping also makes a multi-path insert atomic.
 *
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param text - Text to inject
 * @param bracketed - Whether the remote has bracketed paste enabled
 *   (read from `term.modes.bracketedPasteMode`)
 */
export function injectText(ws: WebSocket | null, text: string, bracketed: boolean): void {
  if (!text) return;
  sendInput(ws, bracketed ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text);
}

/**
 * Tells the server whether this viewer's page is being rendered.
 *
 * A hidden viewer is excluded from the shared-grid decision. It has to be,
 * because a hidden tab is not laid out at all — the browser stops
 * `requestAnimationFrame` and `ResizeObserver` outright, so it cannot re-fit
 * even if it wanted to — and a backgrounded phone holding every other device's
 * terminal at phone size, with nothing on screen to explain it, is
 * indistinguishable from a bug.
 *
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param hidden - `document.hidden`
 */
export function sendVisibility(ws: WebSocket | null, hidden: boolean): void {
  send(ws, { type: "visibility", hidden });
}

/**
 * Chooses how the pane is sized while several devices watch it.
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param mode - `auto` (smallest visible viewer) or `pinned` (one decides)
 * @param viewerId - Which viewer decides under `pinned`
 */
export function sendSizing(ws: WebSocket | null, mode: "auto" | "pinned", viewerId?: string | null): void {
  send(ws, { type: "set-sizing", mode, viewerId: viewerId ?? null });
}
