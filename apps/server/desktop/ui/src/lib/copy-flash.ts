/**
 * Where a Copy button's "copied" flash lives — which is page state, not the
 * DOM.
 *
 * This is the same defect `Show Details` and the reset screen's step rows both
 * had, arriving a third time: `#content` is rebuilt on every render and the
 * poll renders every 1500 ms, so a state carried only by the element is thrown
 * away at a random moment. The flash lasts {@link FLASH_MS}, which is LONGER
 * than the poll's interval, so the check glyph survived a uniformly random
 * 0–1500 ms of its 1600 — a person could press Copy, see the tick, and watch
 * it vanish before they had finished reading it, with nothing wrong and
 * nothing to notice.
 *
 * Keyed by a string the CALLER owns rather than by the element, because the
 * element is exactly the thing that does not survive. A key is a flash slot: two
 * buttons sharing one would share a tick, so each caller names its own.
 *
 * The decision "what does this slot show right now" is {@link flashAt}, pure and
 * taking `now`, so it is testable without a clock and without a webview — the
 * split rule this directory keeps.
 */

/** How long the copied/failed state stays before the button returns to rest. */
export const FLASH_MS = 1600;

/** What a Copy button is showing. `idle` is the resting copy glyph. */
export type FlashState = "idle" | "copied" | "failed";

/** A flash in progress: what it says, and when it stops saying it. */
export interface Flash {
  state: Exclude<FlashState, "idle">;
  /** Epoch ms after which the slot is idle again. */
  until: number;
}

/** What a slot shows at `now`, and how long it has left. */
export interface FlashView {
  state: FlashState;
  /** Milliseconds until this flash expires; `0` when there is nothing to expire. */
  remaining: number;
}

/**
 * The whole decision, as a function of a stored flash and the time.
 *
 * Expiry is by TIMESTAMP rather than by a timer that fired: the timer belongs
 * to a button that may already have been discarded by a render, and a flash
 * whose expiry depended on that timer would outlive its 1600 ms whenever it
 * did.
 */
export function flashAt(flash: Flash | undefined, now: number): FlashView {
  if (!flash || now >= flash.until) return { state: "idle", remaining: 0 };
  return { state: flash.state, remaining: flash.until - now };
}

/** Every live flash, by caller-supplied key. Page state; nothing persists it. */
const flashes = new Map<string, Flash>();

/**
 * What the button for `key` should show now, evicting the slot once it is
 * spent so a page that copies many different things does not accumulate one
 * entry per string forever.
 */
export function readFlash(key: string, now: number = Date.now()): FlashView {
  const view = flashAt(flashes.get(key), now);
  if (view.state === "idle") flashes.delete(key);
  return view;
}

/** Start (or restart) the flash for `key`. */
export function setFlash(key: string, state: Exclude<FlashState, "idle">, now: number = Date.now()): void {
  flashes.set(key, { state, until: now + FLASH_MS });
}

/**
 * Drop every flash. Only for tests that need a fresh module.
 * @internal
 */
export function clearFlashesForTests(): void {
  flashes.clear();
}
