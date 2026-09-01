/**
 * iOS keeps the focused input "in view" by scrolling ITS ancestor scrollers —
 * mid-typing (classically right after the spacebar, when autocorrect commits).
 * On the full-height terminal page that scroller is the shell's page wrapper,
 * and panning it slides the terminal off-screen while typing still works —
 * the "view goes blank / cursor is lost" report. The page is viewport-sized
 * on purpose: while the soft keyboard is up and the terminal holds focus, its
 * scroll position must stay pinned.
 */

/** Whether a page-scroller movement should be undone (pure, tested). */
export function shouldPinAppScroll(args: {
  /** Coarse-pointer (touch) UI — desktop scrolling is always the user's. */
  touchUi: boolean;
  /** The scroller's current offset; 0 has nothing to undo. */
  scrollTop: number;
  /** Soft keyboard is up: the visual viewport is materially shorter than
   * the layout viewport (iOS does not resize the layout viewport). */
  keyboardUp: boolean;
  /** Focus is inside the terminal (the input iOS is chasing). */
  terminalFocused: boolean;
}): boolean {
  return args.touchUi && args.scrollTop > 0 && args.keyboardUp && args.terminalFocused;
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
