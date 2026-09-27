import type { Terminal } from "@xterm/xterm";

/**
 * The private viewport half of a live terminal, as read in the installed
 * 6.1.0-beta.304 build (`src/browser/Viewport.ts` ships inside the package;
 * the `_core._viewport` access survives its minifier). Only `scrollToLine`
 * is touched, and feature-detected — the posture follows `rowHeightPx` in
 * lib/terminal-touch-scroll.ts: a missing private path is a no-op, never a
 * throw.
 */
type PrivateViewport = {
  /**
   * The REAL signature in this build is `(line, disableSmoothScroll)`.
   * With `disableSmoothScroll` true the viewport writes `_latestYDisp =
   * line` and then sets the scroller to `line * cellHeight` immediately —
   * the one absolute position set the class has, and the one form that also
   * heals the guard field `queueSync` misuses. With it false the call reuses
   * the in-flight smooth-scroll animation and leaves `_latestYDisp` stale,
   * which is wrong for a repair. (The public `Terminal.scrollToLine(line)`
   * is not a substitute: it computes `line - ydisp` and no-ops at zero,
   * then delegates to a RELATIVE `setScrollPosition` off the scroller's own
   * current position — so it moves a strayed thumb by the amount it was
   * asked to, never to where the buffer actually is.)
   */
  scrollToLine?: (line: number, disableSmoothScroll?: boolean) => void;
};

/**
 * Re-asserts the overlay scrollbar at the buffer's true line through the
 * private viewport. xterm 6.1-beta's overlay thumb desyncs on resize
 * (upstream issue 6172, in the scroller adopted by upstream PR 5096):
 * `Viewport.queueSync`
 * re-syncs after a resize with its cached `_latestYDisp` as the argument, so
 * `_sync`'s `ydisp !== _latestYDisp` guard sees "no change" and skips the
 * POSITION update — the extent follows the resize, the thumb stays. The
 * operator report of 2026-09-27 was exactly this signature: xterm's own
 * "Jump to bottom" chip was up (scroll state: up in the scrollback) while
 * the thumb rendered at the bottom, and swiping did not move it. Related
 * upstream issue 6117: a resize landing while the renderer is paused can
 * also strand the scroll range. The private `_core._viewport` call is the only absolute
 * re-entry in the build; guarded exactly like `rowHeightPx` — a missing
 * private path (never opened, or an xterm that renamed it) is a no-op, never
 * a throw. The position read is PUBLIC (`buffer.active.viewportY` is the
 * public spelling of the same `ydisp` the viewport syncs against); only the
 * set goes private. `disableSmoothScroll: true` also means the assert cannot
 * masquerade as a user drag: with `ydisp` landing where `_handleScroll`
 * recomputes it, the diff is zero and no scroll request fires back at the
 * buffer.
 */
export function resyncScrollbarToBuffer(term: Terminal): void {
  const viewport = (term as unknown as { _core?: { _viewport?: PrivateViewport } })._core?._viewport;
  viewport?.scrollToLine?.(term.buffer.active.viewportY, true);
}

/** Terminals with a re-assertion already booked for the next frame. */
const pendingResyncs = new WeakSet<Terminal>();

/**
 * Books ONE {@link resyncScrollbarToBuffer} on the next animation frame,
 * coalescing every resize that lands in the current one.
 *
 * A letterbox pass resizes through several doors per frame (the pinned
 * container's ResizeObserver, the settled re-fit, the font-size handler),
 * and the desync is a STATE, not an event: asserting the true line once
 * after the frame repairs all of them at once. Keyed on the terminal, so
 * two panes never coalesce into each other, and a resync that lands after
 * `term.dispose()` reads a disposed viewport — xterm's emitters refuse to
 * fire once disposed, so it is inert, exactly the no-op the guard is for.
 */
export function scheduleScrollbarResync(term: Terminal): void {
  if (pendingResyncs.has(term)) return;
  pendingResyncs.add(term);
  requestAnimationFrame(() => {
    pendingResyncs.delete(term);
    resyncScrollbarToBuffer(term);
  });
}
