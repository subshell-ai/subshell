import type { Terminal } from "@xterm/xterm";

/** Fallback row height when the renderer's metrics are unreachable. */
const FALLBACK_ROW_PX = 18;
/** Testable override of the styles.css `@media (pointer: coarse)` gate. */
const defaultIsTouchUi = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

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
export function attachTouchScroll(
  term: Terminal,
  root: HTMLElement,
  isTouchUi: () => boolean = defaultIsTouchUi,
): () => void {
  if (!isTouchUi()) return () => {};
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
