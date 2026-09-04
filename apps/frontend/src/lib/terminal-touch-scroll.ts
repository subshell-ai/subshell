import type { Terminal } from "@xterm/xterm";

/** Fallback row height when the renderer's metrics are unreachable. */
const FALLBACK_ROW_PX = 18;
/** Pair-gesture deadzone: movement below this decides nothing (finger tremor). */
const PAIR_DEADZONE_PX = 8;
/** Testable override of the styles.css `@media (pointer: coarse)` gate. */
export const isTouchUi = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

/** The renderer's measured CSS row height, private-path-guarded (falls back
 * rather than throwing, so a resize mid-swipe can never kill scrolling). */
function rowHeightPx(term: Terminal): number {
  const core = (
    term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } }
  )._core;
  const h = core?._renderService?.dimensions?.css?.cell?.height;
  return h && h > 0 ? h : FALLBACK_ROW_PX;
}

/**
 * One-finger swipe scrolling for touch devices (the iPhone bug).
 *
 * xterm.js calls preventDefault() on touchmove for its long-press text
 * selection, which cancels the browser's native pan of `.xterm-viewport` —
 * the `touch-action: pan-y` block in styles.css promises a gesture iOS never
 * delivers. A listener of our own still runs (preventDefault cancels the
 * DEFAULT action, not sibling listeners), so this module drives the scroll:
 * vertical swipe distance is converted into terminal LINES (xterm's wheel
 * unit, so swipe and wheel feel identical), with the sub-line remainder
 * carried between events. We also preventDefault, so the shell's scroll
 * container and any late native pan cannot double-scroll alongside us.
 *
 * Two fingers get the same line-scroll with pair arithmetic (the iPad report:
 * a two-finger pan scrolled the PWA shell, not the terminal — `.xterm-screen`
 * has no native scroller under it, so any unconsumed pan bubbles to whatever
 * container the shell gives the gesture). Every two-finger move is consumed
 * (page zoom is already off via `user-scalable=no`, and JS gestures like
 * swipe-nav read the events regardless of preventDefault — only the NATIVE
 * scroll is cancelled, and the shell's is exactly the one we never want);
 * only a decisively VERTICAL pair pan scrolls lines. A dominant-horizontal
 * pair or a changing finger spread decides the gesture as non-scrolling for
 * its remainder, so a pinch never jitters the buffer.
 *
 * Attaches to `.xterm-screen` (the grid body — outside it, the page still
 * scrolls normally: headers, lists, settings). Returns the detach fn.
 */
export function attachTouchScroll(term: Terminal, root: HTMLElement, isTouch: () => boolean = isTouchUi): () => void {
  if (!isTouch()) return () => {};
  const target = root.querySelector<HTMLElement>(".xterm-screen") ?? root;
  let lastY: number | null = null;
  let carry = 0;
  /** Live two-finger gesture: the moving finger-mean (for per-event deltas),
   * the gesture ORIGIN (the deadzone decision is total-from-origin, so a
   * slow drag cannot reset it), and the decision; null between gestures. */
  let pair: {
    avgX: number;
    avgY: number;
    spread: number;
    ox: number;
    oy: number;
    ospread: number;
    mode: "pending" | "scroll" | "off";
  } | null = null;

  const onStart = (e: TouchEvent) => {
    lastY = null;
    pair = null;
    if (e.touches.length === 1) {
      lastY = e.touches[0]?.clientY ?? null;
      carry = 0;
    } else if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      const avgX = (a.clientX + b.clientX) / 2;
      const avgY = (a.clientY + b.clientY) / 2;
      const spread = Math.abs(a.clientY - b.clientY);
      pair = { avgX, avgY, spread, ox: avgX, oy: avgY, ospread: spread, mode: "pending" };
      carry = 0;
    }
  };
  /** Shared line math: LINES per row height, sub-line remainder carried
   * between events. preventDefault stays with the callers — the pair path
   * consumes even its non-scrolling modes, the single path only scrolls. */
  const scrollByDy = (dy: number) => {
    const rowPx = rowHeightPx(term);
    carry += dy;
    const lines = Math.trunc(carry / rowPx);
    if (lines !== 0) {
      carry -= lines * rowPx;
      term.scrollLines(lines);
    }
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && pair) {
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      const avgX = (a.clientX + b.clientX) / 2;
      const avgY = (a.clientY + b.clientY) / 2;
      const spread = Math.abs(a.clientY - b.clientY);
      const dy = pair.avgY - avgY; // fingers UP => positive => scroll toward the bottom
      const dyFromOrigin = pair.oy - avgY;
      // Every pair move ON THE GRID is consumed: nothing below the terminal
      // may native-scroll (that was the bug) and there is no browser default
      // left to preserve here (zoom is off app-wide; swipe-nav is our own JS
      // and reads the event regardless). Scrolling lines is only for the
      // decisively-vertical gesture.
      e.preventDefault();
      if (pair.mode === "pending") {
        const dxFromOrigin = avgX - pair.ox;
        // Decisions are TOTAL from the gesture origin: per-event deltas let a
        // slow drag sit inside the deadzone forever.
        if (Math.abs(spread - pair.ospread) > PAIR_DEADZONE_PX) {
          pair.mode = "off"; // pinch: diverging fingers are not a scroll
        } else if (Math.abs(dyFromOrigin) > PAIR_DEADZONE_PX && Math.abs(dyFromOrigin) >= Math.abs(dxFromOrigin)) {
          pair.mode = "scroll";
          scrollByDy(dyFromOrigin); // consume the deadzone travel too
        } else if (Math.abs(dxFromOrigin) > PAIR_DEADZONE_PX) {
          pair.mode = "off"; // horizontal: swipe-nav's, not ours (it sees the events anyway)
        } // else tremor: held still, still pending
      } else if (pair.mode === "scroll") {
        scrollByDy(dy);
      }
      pair.avgX = avgX;
      pair.avgY = avgY;
      pair.spread = spread;
      return;
    }
    if (e.touches.length !== 1 || lastY === null) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    const dy = lastY - y;
    lastY = y;
    e.preventDefault();
    scrollByDy(dy);
  };
  const onEnd = () => {
    lastY = null;
    carry = 0;
    pair = null;
  };

  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchmove", onMove, { passive: false }); // must be able to preventDefault
  target.addEventListener("touchend", onEnd, { passive: true });
  target.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchmove", onMove);
    target.removeEventListener("touchend", onEnd);
    target.removeEventListener("touchcancel", onEnd);
  };
}

/**
 * Wheel → terminal-buffer bridge for touch devices (the iPad Magic Keyboard
 * report: two-finger scroll on the trackpad moved the whole PWA shell, never
 * the terminal — while touch scrolling worked fine).
 *
 * A trackpad does not produce touch events: it produces `wheel`. And xterm
 * only listens for wheel when the program INSIDE the pane enabled mouse
 * reporting — otherwise the event goes native, and the native walk for a
 * scrollable ancestor passes right by `.xterm-viewport` (a SIBLING of the
 * grid) and lands on the app shell. This module is the missing edge: on
 * coarse-pointer devices, a wheel over the grid scrolls the buffer (same
 * LINES-per-row-height math and carry as the touch swipe, same respect for
 * deltaMode LINE/PAGE) and preventDefaults so nothing else moves.
 *
 * Deliberately skipped: wheels xterm already consumed (a mouse-reporting
 * app called preventDefault first — no double scroll), the viewport strip
 * itself (that is xterm's own scrollbar, native scroll is correct there),
 * and fine-pointer devices entirely (desktop's wheel path is untouched).
 */
export function attachWheelScroll(term: Terminal, root: HTMLElement, isTouch: () => boolean = isTouchUi): () => void {
  if (!isTouch()) return () => {};
  let carry = 0;
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented) return; // consumed upstream (mouse-reporting app)
    const t = e.target;
    if (t instanceof Element && t.closest(".xterm-viewport")) return; // native scrollbar
    e.preventDefault(); // the PWA shell must not move
    if (e.deltaY === 0) return;
    if (e.deltaMode === 1) {
      term.scrollLines(Math.round(e.deltaY)); // DOM_DELTA_LINE
      return;
    }
    if (e.deltaMode === 2) {
      term.scrollLines(Math.round(e.deltaY) * term.rows); // DOM_DELTA_PAGE
      return;
    }
    carry += e.deltaY; // DOM_DELTA_PIXEL: smooth trackpad deltas
    const lines = Math.trunc(carry / rowHeightPx(term));
    if (lines !== 0) {
      carry -= lines * rowHeightPx(term);
      term.scrollLines(lines);
    }
  };
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => root.removeEventListener("wheel", onWheel);
}

/** Movement (CSS px) past which a finger-down gesture is a swipe, not a tap. */
const SWIPE_SLOP_PX = 10;

/**
 * Tap-vs-swipe keyboard gate (2026-09-04 iPhone report: "if I touch ANY part
 * of the terminal, including the scroll bars, it goes into input mode").
 *
 * xterm focuses its helper textarea from the very first POINTERDOWN of a
 * touch — inside the user-gesture window, which is exactly when iOS shows the
 * soft keyboard. That is right for a tap (the user means to type) and wrong
 * for the scroll gestures this phone lives on: a swipe across the grid or a
 * drag of the viewport scrollbar popped the keyboard every time and left it
 * covering half the pane.
 *
 * The gate cannot cancel xterm's focus (its handler runs first on
 * `pointerdown`), so it UN-FOCUSES before iOS commits: a microtask blur for
 * touches that land on the scrollbar/viewport at all, and a first-move blur
 * once a grid touch turns out to be a swipe. A gesture that ends without
 * moving keeps xterm's focus — tapping still opens the keyboard to type.
 * Touch only; mouse/pen keep xterm's own behavior.
 */
export function gateTouchKeyboard(term: Terminal, root: HTMLElement, isTouch: () => boolean = isTouchUi): () => void {
  if (!isTouch()) return () => {};
  const blur = () => term.textarea?.blur();
  let kind: "tap" | "swipe" | "viewport" | null = null;
  let x0 = 0;
  let y0 = 0;

  // Capture phase on the container: iOS dispatches `pointerdown` BEFORE the
  // compatibility `touchstart`, so this classifies the gesture while the
  // finger is still down and before any move. xterm's own focus runs on the
  // same event's bubble phase — the microtask below lands right after it,
  // still inside the gesture turn, so the keyboard for a scrollbar grab
  // never gets to show.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") {
      kind = null;
      return;
    }
    const onViewport = e.target instanceof Element && !!e.target.closest(".xterm-viewport");
    kind = onViewport ? "viewport" : "tap";
    x0 = e.clientX;
    y0 = e.clientY;
    if (onViewport) queueMicrotask(blur);
  };
  // `touchstart` here (not another pointer listener): it fires once per
  // gesture with the stable origin coordinates, after pointerdown classified.
  const onTouchMove = (e: TouchEvent) => {
    if (kind !== "tap" || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.hypot(t.clientX - x0, t.clientY - y0) > SWIPE_SLOP_PX) {
      kind = "swipe";
      blur();
    }
  };
  const onEnd = () => {
    kind = null;
  };

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("touchmove", onTouchMove, { passive: true });
  root.addEventListener("touchend", onEnd, { passive: true });
  root.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    // Removal matches on (type, handler, capture) only — `passive` is an
    // ADD-side option and a non-capture remove covers all three touch types.
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", onEnd);
    root.removeEventListener("touchcancel", onEnd);
  };
}
