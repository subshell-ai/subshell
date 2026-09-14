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
 */

/** How long the copied/failed state stays before the button returns to rest. */
const FLASH_MS = 1600;

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
 * @param getText - The text to copy, read when the button is pressed
 * @param opts.label - What is being copied, for the accessible name
 * @param opts.always - Opt out of the screen-wide busy disable
 */
export function copyButton(getText: () => string, opts: { label?: string; always?: boolean } = {}): HTMLButtonElement {
  const what = opts.label ?? "command";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.dataset.state = "idle";
  copy.innerHTML = svg("copy");
  copy.setAttribute("aria-label", `Copy ${what}`);
  // Copying is most apt precisely while something else is in flight, so some
  // callers keep it live through a re-probe.
  if (opts.always === true) copy.dataset.always = "1";

  const rest = (): void => {
    copy.dataset.state = "idle";
    copy.innerHTML = svg("copy");
    copy.setAttribute("aria-label", `Copy ${what}`);
  };
  copy.addEventListener("click", () => {
    navigator.clipboard
      .writeText(getText())
      .then(() => {
        copy.dataset.state = "copied";
        copy.innerHTML = svg("check");
        copy.setAttribute("aria-label", `${what} copied`);
      })
      .catch(() => {
        copy.dataset.state = "failed";
        copy.setAttribute("aria-label", `Could not copy ${what}`);
      })
      .finally(() => {
        setTimeout(rest, FLASH_MS);
      });
  });
  return copy;
}
