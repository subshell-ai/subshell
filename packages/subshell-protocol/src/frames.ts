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
    }
  | {
      /**
       * Whether this viewer's page is being rendered at all.
       *
       * A hidden tab is excluded from the shared-grid decision: the browser
       * stops laying it out entirely (no `requestAnimationFrame`, no
       * `ResizeObserver`), so it cannot re-fit until it is shown — and a
       * backgrounded phone holding every other device's terminal at phone
       * size, with nothing on screen to explain it, is indistinguishable from
       * a bug.
       */
      type: "visibility";
      /** True while `document.hidden`. */
      hidden: boolean;
    }
  | {
      /**
       * Chooses how this subshell's pane is sized while several devices watch
       * it: `auto` takes the smallest VISIBLE viewer, `pinned` lets one named
       * viewer decide alone.
       *
       * It changes what everyone sees, so it is an `edit` act — a `view`
       * grantee's choice is dropped like its keystrokes.
       */
      type: "set-sizing";
      /** `auto` or `pinned`. */
      mode: "auto" | "pinned";
      /** Which viewer decides under `pinned`; ignored otherwise. */
      viewerId?: string | null;
    };

/**
 * A frame sent by the subshell WebSocket to the browser.
 */
export type ServerFrame =
  | {
      /** `replay` rebuilds history on attach; `output` is live pane output. */
      type: "replay" | "output";
      /** Terminal bytes, including ANSI escape sequences. Absent on empty frames. */
      data?: string;
    }
  | {
      /**
       * The pane's REAL grid, read back from tmux after a resize settled, and
       * announced on attach before the `replay` so the capture paints onto a
       * grid the client already agrees with.
       *
       * This is a statement of fact, never a request. A client renders this
       * grid — letterboxing or scaling it to fit — and must NOT answer by
       * re-asking for a different size: that is the feedback loop that got
       * commit 6351853 reverted, because the terminal re-fits on every layout
       * tick and would trade resizes with a pane that will not take its size.
       * The client's own size requests depend only on its viewport and font.
       */
      type: "geometry";
      /** Pane width in columns. */
      cols: number;
      /** Pane height in rows. */
      rows: number;
    }
  | {
      /**
       * Who else is watching this subshell, pushed on every join, leave and
       * capacity change.
       *
       * A subshell can be open on several devices at once, and each of them
       * constrains the pane's single grid — so "why is my terminal this size?"
       * is only answerable if the client can see the other viewers. It rides
       * the socket that is already open rather than a poll.
       */
      type: "viewers";
      /** This recipient's own entry in {@link viewers}, by id. */
      you: string;
      /** Everyone attached, including the recipient. */
      viewers: ViewerPresence[];
      /** How the pane's grid is currently being decided. */
      sizing: { mode: "auto" | "pinned"; pinnedViewerId: string | null };
    };

/** One device watching a subshell. */
export interface ViewerPresence {
  /** Stable for the lifetime of this socket; the `you` field points at one. */
  id: string;
  /** Human label for the device, as the client reported it. */
  label: string;
  /**
   * The grid this viewer says it can display, or null before it has said.
   * The pane's actual size is the smallest of these, which is what makes the
   * list worth showing: a device listed smaller than the others is the reason
   * everyone's terminal is that size.
   */
  capacity: { cols: number; rows: number } | null;
  /** ISO timestamp of when this viewer attached. */
  since: string;
  /** True when this viewer may type; a `view` grantee is watching only. */
  canInput: boolean;
  /**
   * True while this viewer's page is not being rendered. A hidden viewer is
   * listed but takes no part in sizing, so the list can explain a pane that
   * is NOT sized to the smallest device on it.
   */
  hidden: boolean;
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
  if (frame.type === "visibility") {
    return typeof frame.hidden === "boolean" ? { type: "visibility", hidden: frame.hidden } : null;
  }
  if (frame.type === "set-sizing") {
    if (frame.mode !== "auto" && frame.mode !== "pinned") return null;
    const viewerId = frame.viewerId;
    if (viewerId != null && typeof viewerId !== "string") return null;
    return { type: "set-sizing", mode: frame.mode, viewerId: viewerId ?? null };
  }
  if (frame.type === "resize") {
    const { cols, rows } = frame;
    if (typeof cols !== "number" || typeof rows !== "number") return null;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null;
    return { type: "resize", cols, rows };
  }
  return null;
}

/** Longest device label accepted on the wire. */
export const DEVICE_LABEL_MAX = 40;

/**
 * Normalizes a device label for the wire: control characters replaced,
 * whitespace collapsed, length capped.
 *
 * Shared by both ends deliberately. The label is chosen on one device and
 * rendered in another user's browser (a shared subshell may have viewers who
 * are not its owner), and it also reaches a server log line — so it is
 * sanitized on the way out AND on the way in, rather than trusting either.
 *
 * @param raw - A candidate label
 * @returns The cleaned label, empty when nothing usable remains
 */
export function normalizeDeviceLabel(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL and C1: never printable, and the pair that matters most here is
    // CR/LF, which would forge a second line in the attach log.
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, DEVICE_LABEL_MAX);
}
