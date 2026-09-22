import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, type ClientFrame } from "@internal/subshell-protocol";
import { encodeFrame } from "@internal/subshell-protocol/wire";

/**
 * The sockets the SERVER has confirmed for CBOR. The attach URL's `&enc=cbor`
 * is a REQUEST, not an agreement: a server older than Wave B ignores the
 * param and would drop every binary frame the page sent it (input, resize,
 * visibility, all of it, while its own JSON output kept flowing). So the
 * mark means "a server frame arrived as binary", set once per socket from
 * the page's own message handler, and a per-socket set is the honest place
 * for it: a reconnect builds a new socket and can decide differently, and
 * two sockets in one page (one per terminal pane) never share the answer.
 * Frames the page sends before confirmation (the on-open visibility, an
 * early resize) ride JSON, which a CBOR server accepts as passthrough, so
 * deferring the mode costs only the size win on those frames and nothing
 * else.
 */
const cborSockets = new WeakSet<WebSocket>();

/**
 * Confirms a WebSocket for CBOR after the server answered with a binary
 * frame (spec 2026-09-21 Wave B, as amended against a mixed-version
 * deployment: request with `&enc=cbor`, but never send CBOR until the
 * server has proven it speaks it). Every frame the page sends on it
 * afterwards rides `encodeFrame` instead of `JSON.stringify`.
 * @param ws - The socket that just delivered a binary server frame
 */
export function markCborSocket(ws: WebSocket): void {
  cborSockets.add(ws);
}

/** Serializes and sends a frame when the socket is open; a no-op otherwise. */
function send(ws: WebSocket | null, frame: ClientFrame): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  // One encode decision for the page's every client frame: an un-negotiated
  // socket gets the exact JSON string it always got, a negotiated one gets
  // CBOR bytes (input frames are small, but the mode is one switch per
  // connection and a half-CBOR client would be a protocol of its own).
  ws.send(cborSockets.has(ws) ? encodeFrame(frame) : JSON.stringify(frame));
}

/**
 * Sends raw terminal bytes to the subshell.
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param data - Exact bytes for the pane's process; sent unmodified
 * @param id - The input's id when the retry queue is engaged (spec 2026-09-21
 *   Wave A); absent means the server never advertised acks, and the frame is
 *   exactly what it always was
 */
export function sendInput(ws: WebSocket | null, data: string, id?: number): void {
  if (!data) return;
  send(ws, id === undefined ? { type: "input", data } : { type: "input", data, id });
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
 * Wraps text in bracketed-paste markers when the remote has enabled bracketed
 * paste (DECSET 2004). Shared by {@link injectText} and the upload
 * injection's queue path, so the two cannot drift about what one paste is.
 * @param text - The text the pane's process should see
 * @param bracketed - Whether the remote has bracketed paste enabled
 * @returns The bytes to send as one input
 */
export function pasteWrap(text: string, bracketed: boolean): string {
  return bracketed ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
}

/**
 * Injects text into the subshell as if the user had pasted it.
 *
 * The wrapping matters for injected file paths: they begin with "/", which
 * Claude Code reads as the start of a slash command when it arrives as
 * keystrokes. Wrapping also makes a multi-path insert atomic.
 *
 * @param ws - The subshell socket (may be null while reconnecting)
 * @param text - Text to inject
 * @param bracketed - Whether the remote has bracketed paste enabled
 *   (read from `term.modes.bracketedPasteMode`)
 * @param id - Passed through to {@link sendInput} when the retry queue is engaged
 */
export function injectText(ws: WebSocket | null, text: string, bracketed: boolean, id?: number): void {
  if (!text) return;
  sendInput(ws, pasteWrap(text, bracketed), id);
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
