/**
 * iOS keeps the focused input "in view" by scrolling ITS ancestor scrollers —
 * mid-typing (classically right after the spacebar, when autocorrect commits).
 * On the full-height terminal page that scroller is the shell's page wrapper,
 * and panning it slides the terminal off-screen while typing still works —
 * the "view goes blank / cursor is lost" report. The page is viewport-sized
 * on purpose: while the soft keyboard is up and the terminal holds focus, its
 * scroll position must stay pinned.
 */

/**
 * Whether a scroll event should be undone (pure, tested). The rule: on a
 * touch UI, while the soft keyboard is up and the terminal holds focus, NO
 * scroll outside the terminal is the user's — it can only be iOS chasing the
 * helper textarea. Crucially, iOS pans `overflow: hidden` ancestors too
 * (scrollIntoView does not care), and those invisible pans are exactly the
 * ones a swipe can never undo. Inside-the-terminal scroll (swipe-to-read
 * scrollback, our own scrollToBottom) is always allowed.
 */
export function shouldResetForeignScroll(args: {
  /** Coarse-pointer (touch) UI — desktop scrolling is always the user's. */
  touchUi: boolean;
  /** Soft keyboard is up: the visual viewport is materially shorter than
   * the layout viewport (iOS does not resize the layout viewport). */
  keyboardUp: boolean;
  /** Focus is inside the terminal (the input iOS is chasing). */
  terminalFocused: boolean;
  /** The scrolled thing lives inside the terminal container. */
  insideTerminal: boolean;
}): boolean {
  return args.touchUi && args.keyboardUp && args.terminalFocused && !args.insideTerminal;
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
