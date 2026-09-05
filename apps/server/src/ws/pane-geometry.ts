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
  /**
   * Whether {@link read} can EVER answer for this pane.
   *
   * False disambiguates the null: "this machine has no way to measure a pane"
   * rather than "this pane just died". The first still needs an announcement
   * (see `run`); the second must stay silent, because a pane that has gone is
   * about to take its socket with it.
   */
  confirms: boolean;
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
   * The pane's size after a successful apply: the value read back when the
   * launcher can read it, else the value applied. Called once per settled
   * burst, not once per coalesced request.
   *
   * Either way this is a STATEMENT, never a request — the client pins its
   * grid to it and does not answer, which is what keeps the loop closed. See
   * the note in `run` for why an unreadable pane now reports the applied size
   * instead of staying silent.
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
  /**
   * Set by {@link GeometryQueue.release}. An in-flight `run` captured this
   * object before the release and would otherwise keep going: draining
   * `pending` re-inserts an entry for a subshell nobody is watching, whose
   * stale `applied` then suppresses the next attach's first request.
   */
  released: boolean;
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
  /** {@link release} for every key at once — the test reset. @internal */
  releaseAll(): void;
  /**
   * Records a size the pane was moved to by something OTHER than this queue.
   *
   * `request` short-circuits when the asked-for size equals the last one
   * applied, which is only sound while this queue is the pane's sole writer —
   * and it is not: the attach path fits the pane directly before capturing,
   * and the repaint nudge steps the width ±1. Left unrecorded, those writes
   * make `applied` describe a size the pane no longer holds, and the next
   * client request for that size is dropped as a no-op with nothing reaching
   * tmux (the terminal then stays mis-fitted until the viewport happens to
   * change to some OTHER value).
   */
  seed(key: string, cols: number, rows: number): void;
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
      entry = { busy: false, pending: null, pendingSizer: null, applied: null, released: false };
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
  const run = async (key: string, size: PaneGeometry, sizer: PaneSizer, existing?: Entry): Promise<void> => {
    // The recursive tail reuses the entry it already holds: calling
    // `entryFor` again would resurrect one that `release` deleted mid-apply.
    const entry = existing ?? entryFor(key);
    entry.busy = true;
    try {
      await sizer.apply(size.cols, size.rows);
      entry.applied = size;
      const real = await sizer.read();
      // Confirmed where it can be, else what the pane was ASKED for — but
      // only where a readback was never possible in the first place. A
      // measurable pane that answers null has DIED, and announcing a size for
      // it would tell viewers to lay out a pane that is about to disappear.
      //
      // Announcing nothing was safe only while a pane had one viewer: that
      // viewer rendered its own grid, which is the grid the pane had just
      // been given, so client and pane agreed by construction. With several
      // viewers the pane takes the MINIMUM, so every larger client is
      // guaranteed to render more rows than the pane holds — and a client
      // taller than its pane does not scroll when the pane does, which puts
      // every later relative-positioned frame a row out. That is precisely
      // the corruption this module exists to prevent, so silence is now the
      // more dangerous answer.
      //
      // This costs nothing where a readback exists (tmux on the control-plane
      // host always answers). Where it does not — a pane on an agent node,
      // whose protocol has no size command yet — the applied size is a better
      // number than the client's own: the client's is certain to be wrong the
      // moment anyone smaller attaches, while this one is wrong only if tmux
      // clamped the request. And with ONE viewer the two are the same number,
      // so that path is unchanged.
      if (real) options.onGeometry(key, real);
      else if (!sizer.confirms) options.onGeometry(key, size);
    } catch (err) {
      options.onError?.(err, key);
    } finally {
      entry.busy = false;
    }
    // Released while this apply was in flight: the viewer is gone, so drop
    // whatever coalesced behind it rather than resizing a pane nobody sees.
    if (entry.released) return;
    const next = entry.pending;
    const nextSizer = entry.pendingSizer;
    entry.pending = null;
    entry.pendingSizer = null;
    if (!next || !nextSizer) return;
    // The burst may have settled on the size the pane already holds.
    if (entry.applied && entry.applied.cols === next.cols && entry.applied.rows === next.rows) return;
    await run(key, next, nextSizer, entry);
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
    seed(key, cols, rows) {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
      entryFor(key).applied = { cols, rows };
    },
    release(key) {
      const entry = entries.get(key);
      if (entry) entry.released = true;
      entries.delete(key);
    },
    releaseAll() {
      for (const entry of entries.values()) entry.released = true;
      entries.clear();
    },
  };
}
