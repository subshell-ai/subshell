/**
 * The dashboard's live feed (`/ws/live`, spec 2026-09-19) — one socket per
 * tab carrying every subshell the viewer may see.
 *
 * Shared rather than restated on each side because there are ten frame
 * kinds across two directions now, and the pair that matters is easy to get
 * wrong from one end alone: a SNAPSHOT row is per-viewer and carries its
 * `access`, while a broadcast row cannot — one payload reaches every
 * subscriber of a topic, so there is nobody to stamp it for. That asymmetry
 * is the reason the client keeps the access it already holds and asks for a
 * resync rather than rendering a row it has never seen (§4.1a).
 *
 * The ROW type is a parameter because the two ends genuinely hold different
 * ones: the server's is derived from its own service's return type, the
 * browser's is the SPA's `SubshellView`. What is shared is the envelope.
 */

/**
 * One screencast frame of a pane the viewer watches (spec §6, screencast
 * fan-out).
 *
 * Published ONLY to sockets the broker has verified hold `view` on the row;
 * a subscription is re-checked at `watch` time through the feed's own
 * authorization path. It carries no `ref` on purpose: subscribers address
 * panes by id and refs stay plane-side. This is also why there is no
 * wall-clock field here. The node-to-plane `preview_stream` EVENT is a
 * different shape, lane-addressed by `ref` and stamped `ts`; nothing about
 * this frame should be read as that one crossing over.
 */
export interface PreviewStreamFrame {
  /** Screencast frame for a pane this socket watches. */
  type: "preview-stream";
  /** The subshell whose pane is being cast. */
  id: string;
  /**
   * The bridge's own frame counter, for gap and age reporting on the viewer
   * side. Not an anti-replay slot: the socket already authenticates the
   * subscriber.
   */
  seq: number;
  /** Frame width in pixels; the viewer sizes its canvas from `w` and `h`. */
  w: number;
  /** Frame height in pixels. */
  h: number;
  /** The JPEG, base64-encoded exactly as the node's event carries it. */
  blob: string;
}

/**
 * A frame the server sends.
 *
 * @typeParam SnapshotRow - a row as one viewer sees it, `access` included
 * @typeParam ChangedRow - a row as a BROADCAST carries it: the same fields
 *                         minus anything per-viewer, which is why it defaults
 *                         to nothing rather than to `SnapshotRow`
 */
export type LiveServerFrame<SnapshotRow, ChangedRow> =
  | {
      /** The viewer's whole visible set, sent once at connect and on `resync`. */
      type: "snapshot";
      /** Every subshell this viewer may see, each stamped with their access. Never carries screens. */
      subshells: SnapshotRow[];
    }
  | {
      /** One subshell changed. */
      type: "subshell";
      /** The subshell's id. */
      id: string;
      /** The row, WITHOUT `access` and without a screen — see the module note. */
      row: ChangedRow;
    }
  | {
      /** This viewer can no longer see that subshell: it was deleted, or their grant was revoked. */
      type: "subshell-gone";
      /** The subshell's id. */
      id: string;
    }
  | {
      /**
       * This viewer's access to that subshell MAY have changed — ask again.
       *
       * Asked rather than asserted for two reasons, both of them things a
       * broadcast structurally cannot express. The audience may not be
       * addressable: `live:everyone` subsumes the per-viewer topics, so a
       * grant ending there reaches both the people who kept the row by
       * another route and the people who did not. And a change of LEVEL
       * (`edit` → `view`) moves no field a broadcast carries at all, since a
       * broadcast has no per-viewer `access` to move.
       *
       * A client holding the row answers with `resync`, whose snapshot IS
       * resolved per viewer; a client that does not hold it ignores the
       * frame.
       */
      type: "subshell-recheck";
      /** The subshell's id. */
      id: string;
    }
  | {
      /** A screen this client asked for. */
      type: "preview";
      /** The subshell whose pane was captured. */
      id: string;
      /** The captured lines, top row first. */
      lines: string[];
    }
  | PreviewStreamFrame;

/** A frame the browser sends. A client may ask for screens, a screencast subscription, or the list again. */
export type LiveClientFrame =
  | {
      /** Capture and return these subshells' screens. */
      type: "previews";
      /** Subshell ids; the server filters them to what this viewer may see and caps the count. */
      ids: string[];
    }
  | {
      /**
       * Send the snapshot again.
       *
       * Asked when a broadcast names a row this client has never seen: it
       * carries no `access`, and inventing one would show edit controls to a
       * `view` grantee.
       */
      type: "resync";
    }
  | {
      /**
       * Start streaming this pane's screencast frames (`preview-stream`).
       *
       * The server re-checks visibility on subscribe through the feed's own
       * authorization path; an id this viewer cannot see simply gets no
       * frames.
       */
      type: "watch";
      /** The subshell to watch, by id: refs stay plane-side (spec §6). */
      id: string;
    }
  | {
      /** Stop streaming it. The viewer stops receiving `preview-stream` for this pane. */
      type: "unwatch";
      /** The subshell to stop watching. */
      id: string;
    };

/**
 * Validates a frame off the wire.
 *
 * Client frames are untrusted input, so an unparseable or unknown one is
 * `null` rather than a throw — the socket stays up and the frame is ignored,
 * which is what `parseClientFrame` does for the terminal socket too.
 *
 * `ids` is filtered to strings; the COUNT is bounded by the caller, because
 * that ceiling is a server-side defence rather than part of the contract. A
 * `watch`/`unwatch` instead names exactly one pane, so a frame without a
 * string `id` names nothing to subscribe and is refused, not guessed at.
 */
export function parseLiveClientFrame(raw: unknown): LiveClientFrame | null {
  const frame = typeof raw === "string" ? safeParse(raw) : raw;
  if (!frame || typeof frame !== "object") return null;
  const { type, ids, id } = frame as { type?: unknown; ids?: unknown; id?: unknown };
  if (type === "resync") return { type: "resync" };
  if (type === "watch" || type === "unwatch") {
    return typeof id === "string" ? { type, id } : null;
  }
  if (type !== "previews" || !Array.isArray(ids)) return null;
  return { type: "previews", ids: ids.filter((id): id is string => typeof id === "string") };
}

/** JSON that may not be JSON. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
