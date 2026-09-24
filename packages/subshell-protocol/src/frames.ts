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
      /**
       * This input's id, when the client retries (spec 2026-09-21 Wave A):
       * per-session monotonic from 1, carried across reconnects. The server
       * dedupes a re-sent id against its completed-write window and acks
       * after the pane write lands, so a reconnect retry cannot double-write
       * or lose a keystroke. Absent on every frame an older client sends;
       * those behave exactly as they always did.
       */
      id?: number;
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
      /**
       * True when this server acks input ids (spec 2026-09-21 Wave A). A
       * client that sees it engages its retry queue; one that does not (an
       * older server, most of the cached-PWA window) keeps sending bare
       * input frames. Always true on a current server; the field exists so
       * the client's fallback is a decision the server made, not a guess.
       */
      inputAcks: boolean;
    }
  | {
      /**
       * The pane write for this input id LANDED (spec 2026-09-21 Wave A):
       * the launcher's `sendInput` promise resolved. Emitted to the sending
       * socket only, and also for a deduped re-send: the client must be able
       * to retire an id the server already wrote. Absence after a send means
       * "not yet"; the client's only retry is the next reconnect's re-send.
       */
      type: "ack";
      /** The input id being retired. */
      id: number;
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
    if (typeof frame.data !== "string") return null;
    // An id is optional (old clients, and the unengaged fallback): when
    // present it must be a positive integer, because a fractional or zero id
    // would alias the session's first real keystroke in the dedupe window.
    if (frame.id !== undefined && (typeof frame.id !== "number" || !Number.isInteger(frame.id) || frame.id < 1)) {
      return null;
    }
    return frame.id === undefined
      ? { type: "input", data: frame.data }
      : { type: "input", data: frame.data, id: frame.id };
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
 * Unicode format characters (category Cf): zero-width joiners and spaces,
 * the bidi embeds/overrides/isolates, soft hyphen, BOM, tag characters.
 *
 * None has a printable width and every one can change what the SAME visible
 * text means — U+202E reverses what follows it, U+FE0F flips an emoji's
 * presentation, U+E0020..U+E007F spell invisible payloads inside emoji flag
 * sequences. A label is a name a person reads; none of that belongs in one,
 * and the uniqueness checks that compare these strings (workspace names, node
 * renames) cannot see past them. Emoji variation selectors (U+FE00-U+FE0F,
 * the ones that decide text vs emoji presentation) are category Mn, not Cf,
 * so they are dropped by name rather than assumed covered.
 */
const FORMAT_CHAR = /\p{Cf}/u;
const PRESENTATION_SELECTOR = /[\uFE00-\uFE0F]/u;

/**
 * Normalizes a display label: control characters replaced, format characters
 * dropped, whitespace collapsed, length capped.
 *
 * The one implementation of "a label a person chose on one machine, which a
 * different machine renders or logs" — device labels, node names, the
 * instance name, and the subshell/workspace names written by the control
 * plane. The C0/DEL/C1 pass is the load-bearing part, and the pair that
 * matters most is CR/LF, which would otherwise forge a second line in a log
 * record; the Cf pass and the surrogate drop close the INVISIBLE half of the
 * same class — bytes a reader never sees but a renderer or comparator acts on.
 *
 * NFC runs FIRST so the whole rule operates on canonical forms: new writes
 * through every door unify "cafe" + combining acute and precomposed é into
 * one name, and the cap counts code points of the normalized string. The
 * unification is FORWARD-ONLY: rows written before it landed keep what they
 * got, and the uniqueness checks compare stored bytes, so a decomposed old
 * row and a composed new one can still coexist (no backfill — decided).
 *
 * @param raw - A candidate label
 * @param max - Maximum length of the result
 * @returns The cleaned label, empty when nothing usable remains
 */
export function normalizeLabel(raw: string, max: number): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += " ";
    // Unpaired surrogates: a lone half of a pair equals no valid string at
    // all — unrenderable, and unequal to every later read of the same row.
    // (A PAIRED one never reaches this branch: the for-of above iterates code
    // points, so a valid astral char arrives whole and outside this range.)
    else if (code >= 0xd800 && code <= 0xdfff) continue;
    else if (FORMAT_CHAR.test(ch) || PRESENTATION_SELECTOR.test(ch)) continue;
    else out += ch;
  }
  // Capped over CODE POINTS, which is what the loop above already iterates and
  // what every other cap on these labels counts — the agent's `--name` preflight,
  // the desktop form, the control plane's `chars().count()`. `String.prototype.slice`
  // counts UTF-16 units, so it would both chop an emoji name in half and, at
  // exactly the boundary, leave a lone surrogate: a string nothing downstream can
  // render, hash consistently, or compare to itself.
  return [...out.replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/**
 * The device-label binding of {@link normalizeLabel}.
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
  return normalizeLabel(raw, DEVICE_LABEL_MAX);
}

/**
 * Longest node display name, and the ONE spelling of it.
 *
 * It was three: the rename route's private const, the agent's `MAX_NAME_LEN`, and the
 * desktop app's `MAX_NODE_NAME_LEN`, each a comment away from the enroll route's
 * `maxLength`. A node name now arrives from four places — `subshell setup`'s prompt,
 * `--name`, the desktop Enroll field and enroll's body — so the cap lives here and each
 * site imports it.
 */
export const NODE_NAME_MAX = 64;

/**
 * The UTF-16 ceiling that admits every legal {@link NODE_NAME_MAX}-character name.
 *
 * A cap written in CHARACTERS cannot be handed to a reader that counts CODE UNITS,
 * and two do: JSON Schema's `maxLength` — the enroll and rename bodies, where a
 * `64` would 400 a name of 40 emoji that the normalizer counts as 40 characters —
 * and an HTML `maxlength` attribute. A code point occupies at most two units, so twice
 * the cap admits every name the shared rule accepts and nothing it would not cap
 * anyway. The semantic limit stays {@link normalizeNodeName}'s; this is the
 * transport guard sized so it never fires before that one does.
 */
export const NODE_NAME_MAX_UNITS = NODE_NAME_MAX * 2;

/**
 * The node-name binding of {@link normalizeLabel}.
 *
 * A node name is the row a person reads on the Nodes page, the pickers and the clone
 * dialog, and it reaches log lines and the terminal's menu — so it is sanitized by the
 * same rule as every other human-chosen label rather than by a length check alone.
 * Enroll, rename, the agent and the desktop app all call THIS, so a name cannot be
 * stored differently depending on which door it came through: an empty result means
 * "nothing printable was entered", and a caller refuses rather than storing the empty.
 *
 * @param raw - A candidate node name
 * @returns The cleaned name, empty when nothing usable remains
 */
export function normalizeNodeName(raw: string): string {
  return normalizeLabel(raw, NODE_NAME_MAX);
}
