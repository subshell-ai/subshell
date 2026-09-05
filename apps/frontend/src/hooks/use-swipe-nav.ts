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
 * The drag recognizer's configuration.
 *
 * `keys: false` is the load-bearing one. @use-gesture's drag has KEYBOARD
 * support enabled by default: every ArrowLeft/ArrowRight keydown reaching the
 * bound element adds ±`keyboardDisplacement` (10px) to the gesture's movement
 * and accumulates, with `shiftKey` multiplying it by 10. The terminal lives
 * inside this element, so moving the cursor along an input line drove a
 * synthetic swipe — the viewport crept sideways under the follow-finger
 * transform and, at seven presses (SWIPE_MIN_DX / 10), the keyup committed it
 * and navigated to another subshell. Holding the key repeated it; a single
 * Shift+Arrow cleared the threshold on its own. Measured: nine ArrowRight
 * presses produced `movement.x = 87`.
 *
 * `pointer: { touch: true }` does NOT cover this — it constrains pointer
 * TYPES, and the keyboard path is bound separately (`if (config.keys)`).
 *
 * @param ref - The element the gesture binds to
 * @param enabled - Whether to bind at all
 * @returns The `useDrag` config
 */
export const SWIPE_DRAG_CONFIG = (ref: RefObject<HTMLElement | null>, enabled: boolean) =>
  ({
    target: ref,
    eventOptions: { capture: true },
    // `keys` is nested INSIDE `pointer` (the resolver reads
    // `pointer: { keys = true }`); a top-level `keys: false` is silently
    // ignored, which is why the spy test asserts on movement rather than on
    // the option being present.
    pointer: { touch: true, keys: false },
    filterTaps: true,
    enabled,
  }) as const;

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
  //
  // The element also PUBLISHES whether it is a live swipe target. Written
  // from the same `enabled` the recognizer is configured with, in an effect
  // that commits alongside use-gesture's own binding effect — so the two
  // agree on every settled render. (Not a lock: within one commit the two
  // effects still run in order, so this is "same input, same flush", not
  // "impossible to observe apart".) It is written for
  // the e2e suite, whose whole difficulty with this feature was that nothing
  // observable said when a swipe could work: `enabled` is false until the
  // subshell list has loaded and neighbours exist, the terminal mounts well
  // before that, and a swipe dispatched in between is silently a no-op. The
  // test waited on the terminal, then on the list response, and still lost
  // the race about one run in eleven — because a response ARRIVING is not the
  // app having rendered from it. This is the fact itself rather than a proxy
  // for it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.swipeNav = enabled ? "ready" : "idle";
    if (!enabled) el.style.transform = "";
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
    SWIPE_DRAG_CONFIG(ref, enabled),
  );
}
