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
 * that promotes was never a click, so its trailing `click` is swallowed
 * exactly once (`consumePointerDragClick`); a release under the threshold
 * leaves the click intact.
 */

/** Movement before a press-drag becomes a drag, in CSS pixels. */
export const POINTER_DRAG_THRESHOLD_PX = 8;

/** A registered drop surface. Hit-testing uses `contains` rather than
 *  `elementFromPoint` so the test double and the stack order agree. */
export interface PointerDragZone {
  /** True when the given client-space point falls inside the zone. */
  contains(x: number, y: number): boolean;
  /** Whether the zone would accept a drop right now. */
  enabled(): boolean;
  /** Accept the dragged subshell, same effect as the HTML5 drop. */
  onDrop(subshellId: string): void;
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
let suppressClick = false;

function publish(next: PointerDragState | null): void {
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

export interface BeginPointerSubshellDragOptions {
  subshellId: string;
  /** `e.pointerType` from the source's pointerdown. */
  pointerType: string;
  /** `e.button` from the same event; only the primary button drags. */
  button: number;
  clientX: number;
  clientY: number;
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
    if (zone.contains(x, y) && zone.enabled()) found = zone;
  }
  return found;
}

/**
 * Open a gesture on the source's pointerdown. The session either dies at
 * release (a click), yields to the native `dragstart`, or promotes into a
 * pointer drag. Callers render the row they own; this module owns the
 * listeners, the ghost, the selection suppression, and the drop dispatch.
 */
export function beginPointerSubshellDrag(options: BeginPointerSubshellDragOptions): void {
  // A fresh press resets the click bookkeeping: only the gesture that
  // promoted gets its trailing click swallowed.
  suppressClick = false;
  if (gesture) return;
  if (options.button !== 0) return;
  if (options.pointerType !== "mouse" && options.pointerType !== "pen") return;

  const originX = options.clientX;
  const originY = options.clientY;
  let promoted = false;
  let ghost: HTMLElement | null = null;

  const onMove = (event: PointerEvent): void => {
    const dx = event.clientX - originX;
    const dy = event.clientY - originY;
    if (!promoted) {
      if (dx * dx + dy * dy < POINTER_DRAG_THRESHOLD_PX * POINTER_DRAG_THRESHOLD_PX) return;
      promoted = true;
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
    publish({ subshellId: options.subshellId, overZone: hitTest(event.clientX, event.clientY) });
  };

  const finish = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("dragstart", onNativeDragStart);
    window.removeEventListener("keydown", onKeyDown);
    const wasPromoted = promoted;
    ghost?.remove();
    if (wasPromoted) {
      suppressClick = true;
      document.body.style.removeProperty("user-select");
      publish(null);
      options.onEnd?.();
    }
    gesture = null;
  };

  const onUp = (event: PointerEvent): void => {
    if (promoted) {
      const zone = hitTest(event.clientX, event.clientY);
      zone?.onDrop(options.subshellId);
    }
    finish();
  };

  const onCancel = (): void => {
    finish();
  };

  // The yield rule: whatever browser this is, if it does start an HTML5
  // drag, that transport owns the gesture and this session vanishes.
  const onNativeDragStart = (): void => {
    promoted = false; // an aborted promotion must not swallow the click
    ghost?.remove();
    ghost = null;
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

/** True (once) when the gesture that just ended had promoted — the source's
 *  click handler must ignore that trailing click. */
export function consumePointerDragClick(): boolean {
  const value = suppressClick;
  suppressClick = false;
  return value;
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
