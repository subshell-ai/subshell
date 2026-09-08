/**
 * iOS keeps the focused input "in view" by scrolling ITS ancestor scrollers —
 * mid-typing (classically right after the spacebar, when autocorrect commits).
 * On the full-height terminal page that scroller is the shell's page wrapper,
 * and panning it slides the terminal off-screen while typing still works —
 * the "view goes blank / cursor is lost" report. The page is viewport-sized
 * on purpose: while the terminal is engaged its scroll position must stay
 * pinned — including after the keyboard closes, when a residual pan would
 * otherwise leave the shell off-screen (and off-height).
 */

/**
 * Whether a scroll event should be undone (pure, tested). The rule: on a
 * touch UI, while the terminal is engaged, NO scroll outside the terminal is
 * the user's — it can only be iOS chasing the helper textarea. Crucially,
 * iOS pans `overflow: hidden` ancestors too (scrollIntoView does not care),
 * and those invisible pans are exactly the ones a swipe can never undo — and
 * they SURVIVE the keyboard closing, which is why "engaged" covers the idle
 * state too. Inside-the-terminal scroll (swipe-to-read scrollback, our own
 * scrollToBottom) is always allowed.
 */
export function shouldResetForeignScroll(args: {
  /** Coarse-pointer (touch) UI — desktop scrolling is always the user's. */
  touchUi: boolean;
  /** The terminal is engaged: focus sits inside it (mid-typing, iOS actively
   * chasing the input) or nowhere at all (page idle — a residual pan left
   * behind after the keyboard closed must be undone too). A control elsewhere
   * (dialog, menu) holds focus → its scrolling is legitimate and untouched. */
  engaged: boolean;
  /** The scrolled thing lives inside the terminal container. */
  insideTerminal: boolean;
}): boolean {
  return args.touchUi && args.engaged && !args.insideTerminal;
}

/** How far the keyboard may cover before it counts as up (px of slack for
 * browser chrome jitter and the iOS accessory bar). */
export const KEYBOARD_UP_PX = 120;

/**
 * The keyboard-open test: on iOS the layout viewport (`window.innerHeight`)
 * never changes when the keyboard shows — only `visualViewport.height`
 * shrinks — so the difference between the two is the keyboard.
 */
export function isKeyboardUp(vvHeight: number, innerHeight: number): boolean {
  return innerHeight - vvHeight > KEYBOARD_UP_PX;
}
