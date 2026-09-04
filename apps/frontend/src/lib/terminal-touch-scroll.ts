import type { Terminal } from "@xterm/xterm";

/** Fallback row height when the renderer's metrics are unreachable. */
const FALLBACK_ROW_PX = 18;
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
 * Attaches to `.xterm-screen` (the grid body — outside it, the page still
 * scrolls normally: headers, lists, settings). Returns the detach fn.
 */
export function attachTouchScroll(term: Terminal, root: HTMLElement, isTouch: () => boolean = isTouchUi): () => void {
  if (!isTouch()) return () => {};
  const target = root.querySelector<HTMLElement>(".xterm-screen") ?? root;
  let lastY: number | null = null;
  let carry = 0;

  const onStart = (e: TouchEvent) => {
    // Only single-finger gestures scroll; a second finger (pinch) ends the
    // scroll gesture cleanly so its removal can't cause a jump.
    if (e.touches.length === 1) {
      lastY = e.touches[0]?.clientY ?? null;
      carry = 0;
    } else {
      lastY = null;
    }
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1 || lastY === null) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    const dy = lastY - y; // finger UP => positive => scroll toward the bottom
    lastY = y;
    e.preventDefault();
    const rowPx = rowHeightPx(term);
    carry += dy;
    const lines = Math.trunc(carry / rowPx);
    if (lines !== 0) {
      carry -= lines * rowPx;
      term.scrollLines(lines);
    }
  };
  const onEnd = () => {
    lastY = null;
    carry = 0;
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
