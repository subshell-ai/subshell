/**
 * The dashboard's live feed (`/ws/live`, spec 2026-09-19) — one socket per
 * tab carrying every subshell the viewer may see.
 *
 * Shared rather than restated on each side because there are five frame
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
      /** A screen this client asked for. */
      type: "preview";
      /** The subshell whose pane was captured. */
      id: string;
      /** The captured lines, top row first. */
      lines: string[];
    };

/** A frame the browser sends. The only thing a client may ask for is screens, or the list again. */
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
    };

/**
 * Validates a frame off the wire.
 *
 * Client frames are untrusted input, so an unparseable or unknown one is
 * `null` rather than a throw — the socket stays up and the frame is ignored,
 * which is what `parseClientFrame` does for the terminal socket too.
 *
 * `ids` is filtered to strings; the COUNT is bounded by the caller, because
 * that ceiling is a server-side defence rather than part of the contract.
 */
export function parseLiveClientFrame(raw: unknown): LiveClientFrame | null {
  const frame = typeof raw === "string" ? safeParse(raw) : raw;
  if (!frame || typeof frame !== "object") return null;
  const { type, ids } = frame as { type?: unknown; ids?: unknown };
  if (type === "resync") return { type: "resync" };
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
