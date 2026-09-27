import type { Terminal } from "@xterm/xterm";
import { safeOpenTerminalUri } from "@/lib/terminal-url-open";
import { terminalUrlAtPoint } from "@/lib/terminal-url-tap";

/** Fallback row height when the renderer's metrics are unreachable. */
const FALLBACK_ROW_PX = 18;
/** Pair-gesture deadzone: movement below this decides nothing (finger tremor). */
const PAIR_DEADZONE_PX = 8;
/** A single-finger move arriving more than this long after the last tracked
 * one is a RESUMED gesture (a pause mid-drag, or a gap the copy-mode shield
 * swallowed): it re-anchors instead of scrolling the whole stale delta. */
const STALE_MOVE_MS = 400;
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
 * `copyMode()` true means the pane is in copy mode (issue 242): a
 * one-finger touch belongs to the browser's selection pipeline, so the swipe
 * neither scrolls nor preventDefaults it. The pair path is deliberately
 * untouched — two-finger line-scroll keeps working while you select. In the
 * composed app the copy-mode shield stops those one-finger touches at the
 * root before they reach this listener; the standdown here is the belt for
 * the unshielded path, and its Y/clock tracking doubles as the re-anchor
 * bookkeeping below.
 *
 * A single-finger move that arrives with no tracked start, or after a gap
 * past STALE_MOVE_MS, RE-ANCHORS rather than flinging (issue 242 review): it
 * records the Y and scrolls nothing. Without it, the move right after the
 * copy-mode shield lets the gesture back through would scroll by the whole
 * stale delta in one jump; the same is true of a long pause inside a genuine
 * drag.
 *
 * Attaches to `.xterm-screen` (the grid body — outside it, the page still
 * scrolls normally: headers, lists, settings). Returns the detach fn.
 * `now` is injectable so a test can fake the gap; production runs on
 * `Date.now`.
 */
export function attachTouchScroll(
  term: Terminal,
  root: HTMLElement,
  isTouch: () => boolean = isTouchUi,
  copyMode?: () => boolean,
  now: () => number = Date.now,
): () => void {
  if (!isTouch()) return () => {};
  const target = root.querySelector<HTMLElement>(".xterm-screen") ?? root;
  let lastY: number | null = null;
  let lastMoveAt = 0;
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
    lastMoveAt = now();
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
    if (e.touches.length !== 1) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    if (copyMode?.()) {
      // Copy mode (issue 242): the finger selects, it does not swipe. No
      // scroll, no preventDefault — the browser owns this touch. The Y and
      // the clock are still tracked: they are the anchor to resume from if
      // the mode flips off mid-gesture.
      lastY = y;
      lastMoveAt = now();
      return;
    }
    if (lastY === null || now() - lastMoveAt > STALE_MOVE_MS) {
      // No tracked start (a gesture whose touchstart this listener never saw,
      // e.g. the copy-mode shield swallowed it) or a long silent gap: anchor
      // to THIS point. Scrolling the accumulated stale distance would fling
      // the buffer by however far the finger travelled since the last
      // accepted move — one jump of every skipped row.
      lastY = y;
      carry = 0;
      lastMoveAt = now();
      return;
    }
    const dy = lastY - y;
    lastY = y;
    lastMoveAt = now();
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
 * The scrollbar surfaces: a touch that lands here is reading, never typing.
 *
 * TWO selectors because xterm 6 moved the scrollbar without removing the old
 * element. Measured in 6.1.0-beta.304: `.xterm-viewport` is still in the DOM
 * and still covers the WHOLE terminal box, but it paints under
 * `.xterm-scrollable-element` (its sibling, which holds the grid), so nothing
 * hits it any more — the visible strip is a `.xterm-slider` inside
 * `div.xterm-visible.xterm-scrollbar.xterm-vertical`, 14px wide at the right
 * edge. Matching both keeps this gate right either side of that change; on the
 * 6.1 DOM only the second one ever fires.
 */
const SCROLLBAR_SELECTOR = ".xterm-viewport, .xterm-scrollbar";

/**
 * Tap-vs-swipe keyboard gate: a tap opens the soft keyboard, a scroll gesture
 * never does. It owns BOTH halves, because on a touch device xterm decides
 * neither of them.
 *
 * The blur half is the 2026-09-04 iPhone report ("if I touch ANY part of the
 * terminal, including the scroll bars, it goes into input mode"): a swipe
 * across the grid or a drag of the viewport scrollbar popped the keyboard
 * every time and left it covering half the pane. Those touches are un-focused
 * before iOS commits — a microtask blur for anything landing on the
 * scrollbar/viewport at all, and a first-move blur once a grid touch passes
 * the slop.
 *
 * The focus half is the 2026-09-18 report ("I can't get the input keyboard to
 * show up when I press on the input area"), and it is here because **xterm
 * focuses its helper textarea only from `mousedown`** — measured in
 * 6.1.0-beta.304: `MouseService.bindMouse` binds `_handleMouseDown`, which
 * calls `focus()`, to the compatibility `mousedown` event. That event never
 * arrives on the grid, because xterm's own touch layer cancels the touch that
 * would produce it: `Gesture` (VS Code-derived, new in xterm 6) registers
 * `.xterm-screen` as a target and `preventDefault()`s every `touchstart` it
 * dispatched a gesture for — and a cancelled `touchstart` suppresses the
 * compatibility mouse events in both WebKit and Blink. So on ANY touch device
 * a tap on the grid leaves `document.activeElement` at `body`, and iOS shows
 * no keyboard because nothing was ever focused. (Measured under Chromium
 * coarse-pointer emulation: `touchstart`/`touchend` on `.xterm-screen` arrive
 * `defaultPrevented`, no `mousedown` or `click` follows, and focus never
 * moves; the same tap outside the terminal does produce both.)
 *
 * So the gate focuses the terminal itself, from `touchend` — inside the
 * user-gesture turn, which is what lets iOS raise the keyboard — and only for
 * a gesture that stayed a one-finger tap on the grid. A swipe, a scrollbar
 * drag, a two-finger gesture and a cancelled touch all end without focusing.
 * Touch only; mouse and pen keep xterm's own behavior, which works there
 * because `mousedown` is real.
 *
 * `copyMode()` true (issue 242) suppresses the focus half: a tap in copy
 * mode selects, and a soft keyboard over a selection is the exact wrong
 * answer. The blur halves (swipe, scrollbar) stay — reading gestures have
 * never wanted the keyboard, copy mode or not.
 */
export function gateTouchKeyboard(
  term: Terminal,
  root: HTMLElement,
  isTouch: () => boolean = isTouchUi,
  copyMode?: () => boolean,
): () => void {
  if (!isTouch()) return () => {};
  const blur = () => term.textarea?.blur();
  let kind: "tap" | "swipe" | "scrollbar" | null = null;
  /** A second finger came down during this gesture: never a tap, however it
   * ends. iOS can report both lifts in ONE touchend, so "no fingers left" is
   * not on its own enough to tell a tap from the end of a two-finger pan. */
  let multi = false;
  let x0 = 0;
  let y0 = 0;

  // Capture phase on the container: iOS dispatches `pointerdown` BEFORE the
  // compatibility `touchstart`, so this classifies the gesture while the
  // finger is still down and before any move — and before anything else on
  // the page could have focused something. The microtask blur is kept rather
  // than made conditional: it costs nothing when nothing is focused, and it
  // still answers the case the 2026-09-04 report was about, a scrollbar grab
  // that starts while the keyboard is already up from an earlier tap.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") {
      kind = null;
      return;
    }
    const onScrollbar = e.target instanceof Element && !!e.target.closest(SCROLLBAR_SELECTOR);
    kind = onScrollbar ? "scrollbar" : "tap";
    x0 = e.clientX;
    y0 = e.clientY;
    if (onScrollbar) queueMicrotask(blur);
  };
  // The only thing touchstart is read for: how many fingers are on the glass.
  // `pointerdown` fires once per finger and cannot answer that on its own —
  // the second finger's would re-classify the gesture as a fresh tap.
  const onTouchStart = (e: TouchEvent) => {
    if ((e.touches?.length ?? 0) > 1) multi = true;
  };
  // `touchmove` here (not another pointer listener): it fires once per
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
  const onEnd = (e: Event) => {
    const lastFingerUp = ((e as TouchEvent).touches?.length ?? 0) === 0;
    // Read the classification before clearing it: this is the only moment the
    // whole gesture is known, and the focus has to happen in THIS turn or iOS
    // will not treat it as user-initiated.
    const wasTap = e.type === "touchend" && kind === "tap" && !multi && lastFingerUp;
    kind = null;
    if (lastFingerUp) multi = false;
    // Copy mode never raises the keyboard on a tap (belt to the shield's
    // cancel of the compatibility mousedown — belt because the shield is
    // attached beside this and the two must not disagree about the contract).
    if (wasTap && !copyMode?.()) term.focus();
  };

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: true });
  root.addEventListener("touchend", onEnd, { passive: true });
  root.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    // Removal matches on (type, handler, capture) only — `passive` is an
    // ADD-side option and a non-capture remove covers all four touch types.
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", onEnd);
    root.removeEventListener("touchcancel", onEnd);
  };
}

/** Long-press commit point: Blink and WebKit hand a held touch to the
 * selection pipeline at ~500 ms. A tap must finish clearly below that, or a
 * slow press would both open a URL and start a selection. */
const TAP_MAX_MS = 450;

/**
 * The copy-mode shield (issue 242, touch): while `copyMode()` is true the
 * browser must OWN a one-finger gesture on the grid, because that is what
 * turns a long-press into a native selection with a Copy path — and xterm
 * cannot be merely PAUSED into granting it. Its Gesture service
 * `preventDefault()`s the touchstart it dispatches a gesture for, and a
 * cancelled touchstart kills the native gesture before selection ever
 * begins (the same cancellation gateTouchKeyboard's doc measured for the
 * compatibility mouse events). So this shields rather than pauses:
 * capture-phase listeners on the terminal root `stopPropagation()` the
 * grid's single-finger touch/pointer/mouse gestures, Gesture never sees the
 * touch, nothing cancels it, and the OS selection pipeline runs over the
 * DOM-rendered text (`user-select: text` + `touch-action: auto` come from
 * the `.copy-mode` rules inside styles.css' `@media (pointer: coarse)`).
 *
 * What stays deliberately live during copy mode:
 * - two-finger line-scroll (multi-touch passes; the pair path in
 *   attachTouchScroll consumes it exactly as before);
 * - the scrollbar/viewport strip (xterm's own control — and the keyboard
 *   gate's blur-on-scrollbar still applies);
 * - the wheel bridge (trackpads scroll the buffer mid-select).
 *
 * A CLEAN tap — one finger, no movement past the slop, released well before
 * the long-press timer — gets the shield's only `preventDefault()`, on
 * `touchend`: the compatibility `mousedown` is what would focus xterm and
 * raise the soft keyboard, and a tap must never do that here. The tap then
 * opens the URL under the finger if the tapped token is one
 * (lib/terminal-url-tap.ts); anything else does nothing.
 */
export function attachCopyModeShield(
  term: Terminal,
  root: HTMLElement,
  copyMode: () => boolean,
  isTouch: () => boolean = isTouchUi,
): () => void {
  if (!isTouch()) return () => {};
  /** The gesture currently inside the shield; null while it is not ours. */
  let tap: { x: number; y: number; t: number; moved: boolean } | null = null;

  /** The scrollbar/viewport strip is xterm's own control — never shielded. */
  const onScrollbar = (target: EventTarget | null): boolean =>
    target instanceof Element && !!target.closest(SCROLLBAR_SELECTOR);

  /** Is THIS event inside the shield's remit? Multi-touch belongs to the
   * pair path; the scrollbar belongs to xterm; copy mode off means the old
   * (untouched) stack owns everything. */
  const shielded = (e: Event): boolean =>
    copyMode() && !onScrollbar(e.target) && !(e.type.startsWith("touch") && (e as TouchEvent).touches.length > 1);

  const onTouchStart = (e: TouchEvent) => {
    if (!shielded(e)) {
      tap = null;
      return;
    }
    e.stopPropagation();
    const p = e.touches.length === 1 ? e.touches[0] : undefined;
    tap = p ? { x: p.clientX, y: p.clientY, t: Date.now(), moved: false } : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!shielded(e)) return;
    e.stopPropagation();
    const p = e.touches[0];
    if (tap && p && e.touches.length === 1 && Math.hypot(p.clientX - tap.x, p.clientY - tap.y) > SWIPE_SLOP_PX) {
      tap.moved = true; // a drag: the selection owns it, and a drag opens nothing
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = tap;
    tap = null;
    if (!t || !copyMode() || onScrollbar(e.target)) return; // not our gesture
    e.stopPropagation();
    const p = e.changedTouches?.[0];
    if (!p || t.moved || Date.now() - t.t > TAP_MAX_MS) return; // a drag or a long-press: no open
    e.preventDefault(); // cancel the compatibility mouse → no focus, no keyboard
    const uri = terminalUrlAtPoint(term, p.clientX, p.clientY);
    if (uri) safeOpenTerminalUri(uri);
  };
  const onTouchCancel = (e: TouchEvent) => {
    if (!tap) return;
    tap = null;
    if (shielded(e)) e.stopPropagation();
  };
  /** Copy mode hands the grid to the browser: xterm's mouse and pointer
   * paths (selection, focus, hover links) are as unwelcome there as its
   * touch ones. `mousedown` is the one that focuses the textarea. All three
   * do the same single thing, so they share one `Event`-shaped handler. */
  const stopIfShielded = (e: Event): void => {
    if (shielded(e)) e.stopPropagation();
  };

  // The touch handlers are `TouchEvent`-typed; the tuple erases the literal
  // type strings that would otherwise pick the right DOM overload, so the
  // one real handler each is registered for is exactly its event's shape.
  const listeners: [string, EventListener, boolean][] = [
    ["touchstart", onTouchStart as EventListener, true],
    ["touchmove", onTouchMove as EventListener, true],
    ["touchend", onTouchEnd as EventListener, true],
    ["touchcancel", onTouchCancel as EventListener, true],
    ["pointerdown", stopIfShielded, true],
    ["pointermove", stopIfShielded, true],
    ["pointerup", stopIfShielded, true],
    ["pointercancel", stopIfShielded, true],
    ["mousedown", stopIfShielded, true],
    ["mouseup", stopIfShielded, true],
    ["click", stopIfShielded, true],
  ];
  for (const [type, handler, capture] of listeners) root.addEventListener(type, handler, capture);
  return () => {
    for (const [type, handler, capture] of listeners) root.removeEventListener(type, handler, capture);
  };
}
