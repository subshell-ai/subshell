import { useDrag } from "@use-gesture/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { SWIPE_AXIS_RATIO, SWIPE_EDGE_GUARD, swipeIntent } from "@/lib/swipe-nav";

/** Follow-finger damping: px of translateX per px of drag, capped. */
const FOLLOW_DAMPING = 0.25;
const FOLLOW_MAX_PX = 48;

export interface SwipeNavOptions {
  /** Called when a committed right swipe asks for the previous entry. */
  onPrev: () => void;
  /** Called when a committed left swipe asks for the next entry. */
  onNext: () => void;
  /** Bind only while there is somewhere to go (default `true`). */
  enabled?: boolean;
}

/**
 * Attaches a touch-only prev/next swipe to `ref` (spec 2026-09-04): left →
 * next, right → previous, decided by `swipeIntent` at gesture end. While the
 * finger is down and the drag is horizontal-dominant, the element follows it
 * damped (skipped under `prefers-reduced-motion`); it snaps back on cancel.
 *
 * The listener binds in the CAPTURE phase — xterm owns its subtree's bubble
 * phase (preventDefault on touchmove, selection handlers), and a capture
 * sibling survives all of it (same reasoning as `gateTouchKeyboard`). We never
 * preventDefault: the browser's vertical pan and xterm's own gestures stay
 * untouched, and `pointer: { touch: true }` keeps mouse/touchpad out.
 */
export function useSwipeNav(
  ref: RefObject<HTMLElement | null>,
  { onPrev, onNext, enabled = true }: SwipeNavOptions,
): void {
  // Belt-and-braces latest handlers: use-gesture re-applies this closure on
  // every render anyway, but the ref keeps a drag that outlives the render
  // from calling yesterday's neighbour ids.
  const live = useRef({ onPrev, onNext });
  live.current = { onPrev, onNext };
  const [reduceMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)"));

  // A gesture that never gets its `last` (e.g. SSE drops the row and
  // `enabled` flips false mid-drag, unbinding the listeners) would strand
  // the damped translateX on the element — clear it on unbind too.
  useEffect(() => {
    if (enabled) return;
    if (ref.current) ref.current.style.transform = "";
  }, [enabled, ref]);

  useDrag(
    ({ first, last, movement: [mx, my], initial: [startX] }) => {
      const el = ref.current;
      if (!el) return;
      if (first) el.style.transform = "";
      if (!last) {
        // Follow-finger only in the commit-able regime: horizontal-dominant
        // AND outside the edge guard (a swipe that can never navigate must
        // not animate), and cleared the moment either fails — a drag that
        // turns vertical hands the screen back to the scrollback.
        const vw = window.innerWidth;
        const horizontal = Math.abs(mx) > Math.abs(my) * SWIPE_AXIS_RATIO;
        const committable = startX > SWIPE_EDGE_GUARD && vw - startX > SWIPE_EDGE_GUARD;
        if (!reduceMotion.matches && horizontal && committable) {
          const clamped = Math.max(-FOLLOW_MAX_PX, Math.min(FOLLOW_MAX_PX, mx * FOLLOW_DAMPING));
          el.style.transform = `translateX(${clamped}px)`;
        } else {
          el.style.transform = "";
        }
        return;
      }
      el.style.transform = "";
      // An active text selection means the finger was choosing content, not
      // pages — iOS selection-extension drags can satisfy the geometry.
      if (window.getSelection()?.toString()) return;
      const intent = swipeIntent({ dx: mx, dy: my, startX, viewportWidth: window.innerWidth });
      if (intent === "prev") live.current.onPrev();
      else if (intent === "next") live.current.onNext();
    },
    {
      target: ref,
      eventOptions: { capture: true },
      pointer: { touch: true },
      filterTaps: true,
      enabled,
    },
  );
}
