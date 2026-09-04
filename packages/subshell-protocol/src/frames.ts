/**
 * Start of a bracketed paste (DECSET 2004). Wrapping injected text in these
 * markers makes a TUI treat it as pasted content rather than keystrokes —
 * essential because an injected absolute path begins with "/", which Claude
 * Code would otherwise read as the start of a slash command.
 */
export const BRACKETED_PASTE_START = "\x1b[200~";

/** End of a bracketed paste. Pairs with {@link BRACKETED_PASTE_START}. */
export const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * A frame sent by the browser to the subshell WebSocket.
 *
 * Every client frame is JSON. There is deliberately no "raw text means
 * input" fallback: that heuristic could not distinguish terminal input from
 * a control message when the user pasted a JSON object.
 */
export type ClientFrame =
  | {
      /** Raw terminal input, forwarded to the pane byte for byte. */
      type: "input";
      /**
       * The exact bytes the pane's process should receive. Control bytes are
       * carried as-is (JSON escapes them), so "\r", "\x04" and escape
       * sequences need no extra encoding.
       */
      data: string;
    }
  | {
      /** Client terminal geometry changed; resize the tmux window to match. */
      type: "resize";
      /** Terminal width in columns; must be positive. */
      cols: number;
      /** Terminal height in rows; must be positive. */
      rows: number;
    };

/**
 * A frame sent by the subshell WebSocket to the browser.
 */
export interface ServerFrame {
  /** `replay` rebuilds history on attach; `output` is live pane output. */
  type: "replay" | "output";
  /** Terminal bytes, including ANSI escape sequences. Absent on empty frames. */
  data?: string;
}

/**
 * Validates and narrows an incoming client frame.
 *
 * Accepts either the raw JSON text or an already-parsed object, because
 * Elysia's WebSocket middleware JSON-parses frames before handing them over.
 *
 * @param raw - The frame as received (JSON string or parsed object)
 * @returns The narrowed frame, or `null` if it is not a valid client frame
 */
export function parseClientFrame(raw: string | object): ClientFrame | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type === "input") {
    return typeof frame.data === "string" ? { type: "input", data: frame.data } : null;
  }
  if (frame.type === "resize") {
    const { cols, rows } = frame;
    if (typeof cols !== "number" || typeof rows !== "number") return null;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null;
    return { type: "resize", cols, rows };
  }
  return null;
}
