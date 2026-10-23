/**
 * Types for the slice of noVNC this app uses. The published `@novnc/novnc`
 * ships plain ESM (`exports: ./core/rfb.js`) with no declarations, so the
 * used surface is declared here rather than papered over at the call site
 * (the bcrypt-pbkdf.d.ts precedent). Widen it when something else needs more.
 */
declare module "@novnc/novnc" {
  /** One RFB connection to a VNC server, rendered inside `target`. */
  export default class RFB {
    /**
     * A WebSocket `channel` is spoken to directly: RFB attaches its own
     * listeners to it and never opens a socket of its own, which is how the
     * caller keeps the connection (and its close event) in hand.
     */
    constructor(target: HTMLElement, channel: WebSocket, options?: { credentials?: Record<string, string> });
    /** Scale the remote screen to fit its container. */
    scaleViewport: boolean;
    /** Move keyboard focus into the remote screen on click. */
    focusOnClick: boolean;
    /** Clip the remote screen to its container; when false, noVNC scrolls it. */
    clipViewport: boolean;
    /** Begin a clean disconnect; the `disconnect` event follows when it lands. */
    disconnect(): void;
  }
}
