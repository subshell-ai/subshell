/**
 * The one Copy button in this app.
 *
 * It existed twice the moment the tmux screen grew instructions of its own —
 * same behaviour, same revert — so it lives here and both callers use it. Two
 * copies would be two places for the failure state to drift.
 *
 * **An icon, not the word.** The SPA's `CopyableValue` is a lucide `Copy` that
 * becomes a `Check`, with the state carried on the accessible name; this is
 * that affordance, so the same gesture looks the same in both halves of the
 * product (operator's call, 2026-09-14). The page's CSP allows no remote
 * images, so the two glyphs are inline SVG rather than a sprite or a font.
 *
 * **The flash is page state** (`lib/copy-flash.ts`), not this element's. The
 * assistant rebuilds its content every 1500 ms and this button with it, so a
 * tick living only in the DOM survived a random fraction of its 1600 ms.
 */
import { FLASH_MS, type FlashState, readFlash, setFlash } from "../lib/copy-flash";

/** lucide `copy` and `check`, drawn with the same attributes lucide-react emits. */
const ICON = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;

function svg(shape: keyof typeof ICON): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[shape]}</svg>`;
}

/**
 * A button that copies whatever `getText` answers AT CLICK TIME.
 *
 * Read lazily on purpose: the caller's text can be rewritten between renders,
 * and a button holding a string captured when it was built would copy
 * something the screen no longer shows.
 *
 * Icon-only, so the state has to live on the accessible name — a check glyph
 * says nothing to a screen reader. A failure is SHOWN as well as announced:
 * the clipboard can be refused, and a button that flashed nothing would read
 * as a press that did not register.
 *
 * Never disabled, by construction rather than by an opt-out: copy buttons are
 * built here and not through the screens' `button()` helper, which is what the
 * screen-wide busy state reaches. That is the behaviour the tmux warning wants
 * anyway — its whole moment is "an action is refused until you install
 * something", and being unable to copy the fix while a re-probe is in flight
 * would be the worst possible timing.
 *
 * @param getText - The text to copy, read when the button is pressed
 * @param opts.key - This button's flash slot, stable across renders of the
 *   same button and distinct from every other button's. The command being
 *   copied is usually the right one.
 * @param opts.label - What is being copied, for the accessible name
 */
export function copyButton(getText: () => string, opts: { key: string; label?: string }): HTMLButtonElement {
  const what = opts.label ?? "command";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";

  const paint = (state: FlashState): void => {
    copy.dataset.state = state;
    // The failed state keeps the copy glyph — there is no lucide mark for "try
    // again" that reads as anything but a second action — so the announcement
    // is what distinguishes it, which is why the label is set on every path.
    copy.innerHTML = svg(state === "copied" ? "check" : "copy");
    copy.setAttribute(
      "aria-label",
      state === "copied" ? `${what} copied` : state === "failed" ? `Could not copy ${what}` : `Copy ${what}`,
    );
  };

  // Built mid-flash: a render landed between the press and the rest, so this
  // element takes over the tick the discarded one was showing, for the time it
  // had left rather than for a fresh 1600 ms.
  const start = readFlash(opts.key);
  paint(start.state);
  if (start.state !== "idle") setTimeout(() => paint(readFlash(opts.key).state), start.remaining);

  copy.addEventListener("click", () => {
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        setFlash(opts.key, "copied");
        paint("copied");
      })
      .catch(() => {
        setFlash(opts.key, "failed");
        paint("failed");
      })
      .finally(() => {
        // Re-read rather than resting blindly: a second press during the flash
        // moved the deadline, and this timer must not cut the newer one short.
        setTimeout(() => paint(readFlash(opts.key).state), FLASH_MS);
      });
  });
  return copy;
}
