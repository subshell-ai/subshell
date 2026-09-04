/**
 * Per-subshell resize serialization with readback.
 *
 * A tmux pane has exactly one grid, and until now client resizes reached it
 * fire-and-forget (`void launcher.resize(...)`) with no ordering and no
 * confirmation. Measured live (2026-09-04): the browser's last request was
 * 51x13 while the pane sat at 51x16 — the SUPERSEDED value — on a healthy
 * socket, with tmux perfectly willing to take 13. Because the harness TUIs
 * position every frame with relative moves (`ESC[nA`/`ESC[nB`) and rewrite
 * only changed spans, a grid that differs from the pane by even one row makes
 * every later frame land on the wrong rows: the screen freezes mid-selection
 * or fills with superimposed frames, and only a reattach clears it.
 *
 * This module is the loop-free half of the fix that commit 6351853 bundled
 * and eee3a92 reverted. It keeps what the revert itself called loop-free —
 * serialize, coalesce, read the real size back — and deliberately does NOT
 * include the half that caused the revert: an acknowledgement timer, bounded
 * re-asks, and conforming the client's grid to the pane. Those closed a
 * feedback loop against a component that re-fits on every layout tick, so a
 * pane that would not take a size could trade resizes with it indefinitely.
 * Here the server simply announces the truth; reacting to it is the client's
 * business, and the client never asks again on that account.
 */

/** The pane operations this queue needs, injected so tests need no tmux. */
export interface PaneSizer {
  /** Propagates a grid size to the pane. */
  apply(cols: number, rows: number): Promise<void>;
  /** Reads the pane's REAL grid back, or null when it cannot be read. */
  read(): Promise<{ cols: number; rows: number } | null>;
}

/** A terminal grid size. */
export interface PaneGeometry {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
}

/** Callbacks a {@link createGeometryQueue} owner supplies. */
export interface GeometryQueueOptions {
  /**
   * The pane's confirmed size, after a successful apply + readback. Called
   * once per settled burst — not once per coalesced request — and never with
   * an unreadable size.
   */
  onGeometry(key: string, size: PaneGeometry): void;
  /** A failed apply or readback. The queue stays usable either way. */
  onError?(err: unknown, key: string): void;
}

/** One subshell's queue state. */
interface Entry {
  /** True while an apply is in flight. */
  busy: boolean;
  /** The size requested while busy, collapsed to the most recent. */
  pending: PaneGeometry | null;
  /** Sizer to use for `pending` (the latest requester's). */
  pendingSizer: PaneSizer | null;
  /** Last size successfully applied, so a repeat request is a cheap no-op. */
  applied: PaneGeometry | null;
}

/** A serialize/coalesce queue keyed by subshell id. */
export interface GeometryQueue {
  /**
   * Asks for a pane size. Returns immediately: at most one apply per subshell
   * is ever in flight, and requests arriving during one collapse to the last
   * (a sash drag emits one per animation frame, and every extra round trip is
   * a chance to land out of order).
   */
  request(key: string, cols: number, rows: number, sizer: PaneSizer): void;
  /** Drops a subshell's state — call when its last viewer detaches. */
  release(key: string): void;
}

/**
 * Creates a resize queue that serializes and coalesces per subshell and
 * reports each settled size.
 * @param options - Geometry and error callbacks
 * @returns The queue
 */
export function createGeometryQueue(options: GeometryQueueOptions): GeometryQueue {
  const entries = new Map<string, Entry>();

  const entryFor = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { busy: false, pending: null, pendingSizer: null, applied: null };
      entries.set(key, entry);
    }
    return entry;
  };

  /**
   * Applies one size, reports the readback, then drains whatever coalesced
   * behind it. Recurses through `pending` rather than looping so a burst that
   * keeps arriving mid-apply is always answered by exactly one more round
   * trip carrying the newest size.
   */
  const run = async (key: string, size: PaneGeometry, sizer: PaneSizer): Promise<void> => {
    const entry = entryFor(key);
    entry.busy = true;
    try {
      await sizer.apply(size.cols, size.rows);
      entry.applied = size;
      const real = await sizer.read();
      // A dead pane reads as null; reporting 0x0 would tell every viewer to
      // paint into nothing.
      if (real) options.onGeometry(key, real);
    } catch (err) {
      options.onError?.(err, key);
    } finally {
      entry.busy = false;
    }
    const next = entry.pending;
    const nextSizer = entry.pendingSizer;
    entry.pending = null;
    entry.pendingSizer = null;
    if (!next || !nextSizer) return;
    // The burst may have settled on the size the pane already holds.
    if (entry.applied && entry.applied.cols === next.cols && entry.applied.rows === next.rows) return;
    await run(key, next, nextSizer);
  };

  return {
    request(key, cols, rows, sizer) {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
      const entry = entryFor(key);
      const size = { cols, rows };
      if (entry.busy) {
        entry.pending = size;
        entry.pendingSizer = sizer;
        return;
      }
      if (entry.applied && entry.applied.cols === cols && entry.applied.rows === rows) return;
      void run(key, size, sizer);
    },
    release(key) {
      entries.delete(key);
    },
  };
}
