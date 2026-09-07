/**
 * Per-DEVICE subshell swipe navigation (localStorage, not user_meta) — the
 * same tier as `terminal-font-size`: walking the sidebar with a thumb is a
 * property of the screen you hold, not of the account. Default ON: the
 * gesture only exists on touch surfaces and every rule in `swipe-nav.ts`
 * keeps it out of the terminal's own gestures; the switch is the escape
 * hatch for anyone who still wants the horizontal drag to the pane alone.
 */

/** Storage value meaning "off"; everything else (or nothing) means on. */
const OFF = "0";

const KEY = "subshell.swipeNav";

/** Whether THIS device should honour prev/next swipes on subshell pages. */
export function swipeNavEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== OFF;
  } catch {
    // Private-mode throws on access; an absent decision defaults on.
    return true;
  }
}

/**
 * Persist this device's choice. Returns the stored state so callers bind
 * their switch to truth, not to intent.
 */
export function setSwipeNavEnabled(on: boolean): boolean {
  try {
    localStorage.setItem(KEY, on ? "1" : OFF);
  } catch {
    // Storage refused (private mode/quota): the choice still holds for this
    // page load — the caller's state is the source of truth while mounted.
  }
  return on;
}
