import { useDrag } from "@use-gesture/react";
import { type RefObject, useRef, useState } from "react";
import { SWIPE_AXIS_RATIO, swipeIntent } from "@/lib/swipe-nav";

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
  // Latest handlers without re-creating the gesture controller on every render
  // (the drag may outlive the render that armed its callbacks).
  const live = useRef({ onPrev, onNext });
  live.current = { onPrev, onNext };
  const [reduceMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)"));

  useDrag(
    ({ first, last, movement: [mx, my], initial: [startX] }) => {
      const el = ref.current;
      if (!el) return;
      if (first) el.style.transform = "";
      if (!last) {
        if (!reduceMotion.matches && Math.abs(mx) > Math.abs(my) * SWIPE_AXIS_RATIO) {
          const clamped = Math.max(-FOLLOW_MAX_PX, Math.min(FOLLOW_MAX_PX, mx * FOLLOW_DAMPING));
          el.style.transform = `translateX(${clamped}px)`;
        }
        return;
      }
      el.style.transform = "";
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
