import { useEffect, useRef, useState } from "react";

/**
 * The pointer-event transport beside the HTML5 drag-and-drop payload
 * (`lib/subshell-dnd.ts`), for the one place the browser will not cooperate:
 * iPadOS Safari fires no `dragstart` from a Magic Keyboard trackpad
 * (operator report 2026-10-30) — a press-drag over a `draggable` row falls
 * through to text selection instead. Touch input is deliberately NOT bridged
 * (finger keeps whatever native path it has, and a touch session would
 * fight rail scrolling); `mouse` and `pen` pointers only.
 *
 * The bridge is a SECOND transport, not a replacement: the first `dragstart`
 * of a gesture yields the whole session, so on desktop — where Chromium,
 * Firefox and macOS Safari all fire the native event within the first few
 * pixels — nothing here ever promotes and the HTML5 path stays byte-identical.
 * What a promoted session does is exactly what the native gesture does to
 * the same surfaces: publish the subshell id so zones arm, mark the zone
 * under the pointer, and hand the id to that zone's drop callback.
 *
 * Click safety: a rail row is also a button (click means the tab). A gesture
 * that promoted was never a click, so the trailing `click` ON THAT ROW
 * SUBTREE is swallowed once (`consumePointerDragClick`); a release under the
 * threshold leaves the click intact, and a click on anything else never
 * touches the flag.
 */

/** Movement before a press-drag becomes a drag, in CSS pixels. */
export const POINTER_DRAG_THRESHOLD_PX = 8;

/** A registered drop surface. */
export interface PointerDragZone {
  /** True when the given client-space point falls inside the zone. */
  contains(x: number, y: number): boolean;
  /** Whether the zone would accept a drop right now. Read AT hit-test time,
   *  so it must not depend on a re-render the promotion has not caused yet
   *  (zones whose offer depends on the gesture arm themselves off
   *  `getPointerDragState()` inside this callback). */
  enabled(): boolean;
  /** Accept the dragged subshell, same effect as the HTML5 drop. */
  onDrop(subshellId: string): void;
  /** The zone's DOM element, when it has one. hitTest then also requires the
   *  topmost element at the point to live inside it, so a release over an
   *  open menu or dialog cannot land on the zone it visually covers. */
  rootElement?: () => HTMLElement | null;
}

/** The published state of a promoted gesture: what is flying, and where. */
export interface PointerDragState {
  subshellId: string;
  /** The zone currently under the pointer, or null. */
  overZone: PointerDragZone | null;
}

type Listener = (state: PointerDragState | null) => void;

const listeners = new Set<Listener>();
const zones = new Set<PointerDragZone>();
let state: PointerDragState | null = null;
let suppressClickFor: HTMLElement | null = null;

function publish(next: PointerDragState | null): void {
  // Skip no-op frames. pointermove fires 60–120×/s and every zone host keeps
  // this object in React state, so a fresh allocation per move re-renders the
  // dock and both sidebar sections for a pixel of ghost travel — the ghost
  // itself is moved by direct style writes, not state. `overZone` identity is
  // stable (registered objects), so Object.is answers "nothing changed" and
  // the hosts' setState bails out too.
  if (
    state === next ||
    (state !== null && next !== null && state.subshellId === next.subshellId && state.overZone === next.overZone)
  ) {
    return;
  }
  state = next;
  for (const listener of [...listeners]) listener(state);
}

/** Observe the promoted gesture (null once it ends). */
export function subscribePointerDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Register a drop surface. Later registrations win a tie, matching paint
 *  order well enough for the few zones that can nest. */
export function registerPointerDragZone(zone: PointerDragZone): () => void {
  zones.add(zone);
  return () => {
    zones.delete(zone);
  };
}

/** Live read of the promoted gesture, synchronously — the escape hatch for
 *  a zone whose `enabled()` must be true in the same task as the promotion,
 *  before React has re-rendered anything (`onPromote` arms through state,
 *  and a quick flick's pointerup can beat that render). */
export function getPointerDragState(): PointerDragState | null {
  return state;
}

export interface BeginPointerSubshellDragOptions {
  subshellId: string;
  /** `e.pointerType` from the source's pointerdown. */
  pointerType: string;
  /** `e.button` from the same event; only the primary button drags. */
  button: number;
  clientX: number;
  clientY: number;
  /** The row the press started on: a promoted gesture's trailing click is
   *  swallowed only within this subtree, so a stale flag can never eat an
   *  unrelated click (or a focused link's Enter). */
  sourceElement: HTMLElement;
  /** Whether this row drags at all (cross-agent helpers are refused at the
   *  source, like their HTML5 `draggable` is false). Checked AFTER the click
   *  bookkeeping reset, so a refused press still clears a stale swallow. */
  enabled?: boolean;
  /** Snapshot floated under the pointer once promoted; null skips the ghost. */
  createGhost?: () => HTMLElement | null;
  /** Fires once on promotion — arm the zones the way `dragstart` would. */
  onPromote?: () => void;
  /** Fires after a promoted gesture ends (drop, cancel, or release). */
  onEnd?: () => void;
}

interface ActiveGesture {
  cancel: () => void;
}
let gesture: ActiveGesture | null = null;

function hitTest(x: number, y: number): PointerDragZone | null {
  let found: PointerDragZone | null = null;
  for (const zone of zones) {
    if (!zone.contains(x, y) || !zone.enabled()) continue;
    const root = zone.rootElement?.() ?? null;
    if (root && typeof document.elementFromPoint === "function") {
      const top = document.elementFromPoint(x, y);
      // The z-order guard: a release over a menu or dialog covering the zone
      // belongs to the overlay, not the zone. A no-layout engine answers
      // null or the bare document/body — that is not evidence of an overlay,
      // so the rect decides.
      if (top && top !== document.body && top !== document.documentElement && !root.contains(top)) continue;
    }
    found = zone;
  }
  return found;
}

/**
 * Did the release happen over the row that started the press? The browser
 * fires the trailing `click` on the nearest common ancestor of the down and
 * up targets — so a click reaches the row exactly when the release lands
 * back inside it. That is the only case needing a swallow, and the test
 * mirrors the browser's own: the event target when a real one exists, the
 * element's rect (or its topmost element) otherwise.
 */
function isPointInElementTree(el: HTMLElement, event: PointerEvent): boolean {
  if (event.target instanceof Node && el.contains(event.target)) return true;
  if (typeof document.elementFromPoint === "function") {
    const top = document.elementFromPoint(event.clientX, event.clientY);
    if (top && top !== document.body && top !== document.documentElement) {
      return el.contains(top);
    }
  }
  const r = el.getBoundingClientRect();
  return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
}

/**
 * Open a gesture on the source's pointerdown. The session either dies at
 * release (a click), yields to the native `dragstart`, or promotes into a
 * pointer drag. Callers render the row they own; this module owns the
 * listeners, the ghost, the selection suppression, and the drop dispatch.
 */
export function beginPointerSubshellDrag(options: BeginPointerSubshellDragOptions): void {
  // A fresh press ends any promoted gesture's claim on the next click,
  // whatever this press goes on to do — including a refused press.
  suppressClickFor = null;
  // The gates first, because a press this transport could never own is not
  // evidence of anything: a finger tap (touch, which the native transport
  // owns) or a right-click can genuinely COEXIST with a promoted trackpad
  // drag, and cancelling on those would abort a live gesture whose release
  // then lands with nothing to swallow it.
  if (options.button !== 0) return;
  if (options.pointerType !== "mouse" && options.pointerType !== "pen") return;
  // A fresh PRIMARY mouse/pen press, by contrast, is physical proof the old
  // press ended — one mouse cannot press button 0 twice. So any session still
  // live here is a stuck one (implicit capture is touch-only; a release
  // outside the window never arrives): cancelling it is what unbricks later
  // drags and disarms the `onUp` that would otherwise answer the next
  // unrelated pointerup by dropping the stale id wherever the pointer is.
  // This runs even for a row this press would refuse (`enabled`): the refusal
  // decides whether a NEW session opens, not whether the old one may live.
  gesture?.cancel();
  if (options.enabled === false) return;

  const originX = options.clientX;
  const originY = options.clientY;
  let promoted = false;
  // Separate from `promoted` because the native yield zeroes it: the
  // CLEANUPS a promotion made (body selection, published state) must run
  // even when the gesture ends by handing over to the HTML5 transport.
  let everPromoted = false;
  // Whether the release landed back on the source row. A trailing `click`
  // fires on the row exactly then (down and up share that subtree), so that
  // is the one case needing a swallow — NOT "no zone took it": a row living
  // inside the zero-workspace create zone both drops AND would click
  // (review round 4, MINOR-2). A release over an unrelated point produces
  // no click at all, so arming there would only strand a flag eager to eat a
  // later keyboard Enter.
  let releasedOverSource = false;
  let ghost: HTMLElement | null = null;
  let settled = false;

  const finish = (): void => {
    if (settled) return;
    settled = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("dragstart", onNativeDragStart);
    window.removeEventListener("keydown", onKeyDown);
    try {
      const wasPromoted = promoted;
      ghost?.remove();
      ghost = null;
      if (everPromoted) {
        document.body.style.removeProperty("user-select");
        publish(null);
      }
      if (wasPromoted) {
        if (releasedOverSource) suppressClickFor = options.sourceElement;
        options.onEnd?.();
      }
    } finally {
      // No throw in the block above may leave the transport bricked: the
      // next press must be able to begin.
      gesture = null;
    }
  };

  const onMove = (event: PointerEvent): void => {
    const dx = event.clientX - originX;
    const dy = event.clientY - originY;
    if (!promoted) {
      if (dx * dx + dy * dy < POINTER_DRAG_THRESHOLD_PX * POINTER_DRAG_THRESHOLD_PX) return;
      promoted = true;
      everPromoted = true;
      document.body.style.userSelect = "none";
      // A press-drag may already have started selecting text before the
      // threshold is crossed; clear it so the row does not paint blue.
      window.getSelection()?.removeAllRanges();
      ghost = options.createGhost?.() ?? null;
      if (ghost) {
        ghost.style.position = "fixed";
        ghost.style.pointerEvents = "none";
        ghost.style.zIndex = "2147483647";
        ghost.setAttribute("aria-hidden", "true");
        document.body.append(ghost);
      }
      options.onPromote?.();
    }
    if (ghost) {
      ghost.style.left = `${event.clientX + 8}px`;
      ghost.style.top = `${event.clientY + 8}px`;
    }
    // A zone whose contains()/enabled()/rootElement() throws must not kill
    // the move handler (happy-dom rethrows out of dispatchEvent, and a real
    // listener throw is swallowed by the UA anyway — either way the gesture
    // would strand). Degrade to "no zone" for that frame.
    let over: PointerDragZone | null = null;
    try {
      over = hitTest(event.clientX, event.clientY);
    } catch (err) {
      console.error("subshell pointer hit-test failed", err);
    }
    publish({ subshellId: options.subshellId, overZone: over });
  };

  const onUp = (event: PointerEvent): void => {
    // The whole body is guarded and finish() runs in the finally: a zone
    // whose contains()/enabled()/rootElement()/onDrop() throws must never
    // strand the listeners, the published state, or the gesture sentinel
    // (round-4 MINOR-1 — hitTest used to sit outside any guard), nor escape
    // the listener into the UA's error path.
    try {
      if (promoted) {
        releasedOverSource = isPointInElementTree(options.sourceElement, event);
        const zone = hitTest(event.clientX, event.clientY);
        if (zone) {
          zone.onDrop(options.subshellId);
        }
      }
    } catch (err) {
      console.error("subshell pointer release failed", err);
    } finally {
      finish();
    }
  };

  const onCancel = (): void => {
    finish();
  };

  // The yield rule: whatever browser this is, if it does start an HTML5
  // drag, that transport owns the gesture and this session vanishes.
  // `promoted` zeroes so the trailing-click and onEnd bookkeeping stays
  // native's; `everPromoted` still cleans up what this session did.
  const onNativeDragStart = (): void => {
    promoted = false;
    finish();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") finish();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("dragstart", onNativeDragStart);
  window.addEventListener("keydown", onKeyDown);
  gesture = { cancel: finish };
}

/** True (once) when the click belongs to the row whose gesture just
 *  promoted — the row's click handler must ignore that trailing click. A
 *  click on anything else never consumes the flag. */
export function consumePointerDragClick(target?: EventTarget): boolean {
  const source = suppressClickFor;
  suppressClickFor = null;
  if (!source) return false;
  return target instanceof Node ? source === target || source.contains(target) : true;
}

/**
 * The zone-side hook: registers the surface for the session's lifetime and
 * reports whether a promoted gesture is flying and whether it hovers HERE.
 * The zone object is kept in a ref so re-renders (membership flipping
 * `enabled`) never re-register or stale-close the handlers.
 */
export function usePointerDragZone(zone: PointerDragZone): { active: PointerDragState | null; over: boolean } {
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const stable = useRef<PointerDragZone>({
    contains: (x, y) => zoneRef.current.contains(x, y),
    enabled: () => zoneRef.current.enabled(),
    onDrop: (id) => zoneRef.current.onDrop(id),
    rootElement: () => zoneRef.current.rootElement?.() ?? null,
  });
  const [active, setActive] = useState<PointerDragState | null>(null);
  useEffect(() => {
    const unregister = registerPointerDragZone(stable.current);
    const off = subscribePointerDrag(setActive);
    return () => {
      off();
      unregister();
      setActive(null);
    };
  }, []);
  return { active, over: active?.overZone === stable.current };
}

/** Drop every piece of module state — for tests only. @internal */
export function resetPointerDragForTests(): void {
  gesture?.cancel();
  gesture = null;
  suppressClickFor = null;
  state = null;
  zones.clear();
  listeners.clear();
  document.body.style.removeProperty("user-select");
}
