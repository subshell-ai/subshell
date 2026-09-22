/**
 * The one Copy button in this app (spec 2026-09-21; plan Task 4, written here
 * in Task 3 because the tmux screen already needs it).
 *
 * It existed twice the moment the tmux screen grew instructions of its own —
 * same behaviour, same revert — so it lives here and every caller uses it.
 * Two copies would be two places for the failure state to drift.
 *
 * **An icon, not the word.** The SPA's `CopyableValue` is a lucide `Copy` that
 * becomes a `Check`, with the state carried on the accessible name; this is
 * that affordance, so the same gesture looks the same in both halves of the
 * product (operator's call, 2026-09-14). The VISUALS are the client
 * assistant's CopyButton — the kit's ghost icon-sm `Button` carrying lucide's
 * own glyphs — reconciled with THIS app's API, which is load-bearing and
 * unchanged: the text is read through `getText` at click time and the flash
 * slot is named by `copyKey`.
 *
 * **The flash is component state now.** The old page held it in a module map
 * (`lib/copy-flash.ts`) because the DOM was rebuilt every 1500 ms and an
 * element-lifetime tick was thrown away at a random moment; a React component
 * persists across re-renders, so its own state IS the slot, and the expiry is
 * a timer this component owns and cleans up. The keyed-by-string API stays so
 * call sites read the same — and a second press during the flash still
 * restarts it rather than being cut short, which is what the old re-read
 * dance existed for.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FLASH_MS, type FlashState } from "../lib/copy-flash";

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
 * not built through the screens' busy-disabling pattern, and that is the
 * behaviour the tmux warning wants anyway — its whole moment is "an action is
 * refused until you install something", and being unable to copy the fix
 * while a re-probe is in flight would be the worst possible timing.
 */
export function CopyButton(props: {
  /** The text to copy, read when the button is pressed. */
  getText: () => string;
  /** This button's flash slot, stable across renders and distinct per button. */
  copyKey: string;
  /** What is being copied, for the accessible name. */
  label?: string;
}): React.JSX.Element {
  const what = props.label ?? "command";
  const [state, setState] = useState<FlashState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A flash that outlives this element has nowhere to be shown; drop the timer
  // so an unmounted button never writes state again.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const flash = (next: Exclude<FlashState, "idle">): void => {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), FLASH_MS);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-state={state}
      onClick={() => {
        navigator.clipboard.writeText(props.getText()).then(
          () => flash("copied"),
          () => flash("failed"),
        );
      }}
      aria-label={
        state === "copied" ? `${what} copied` : state === "failed" ? `Could not copy ${what}` : `Copy ${what}`
      }
    >
      {/* The failed state keeps the copy glyph — there is no lucide mark for "try
          again" that reads as anything but a second action — so the announcement
          is what distinguishes it, which is why the label is set on every path. */}
      {state === "copied" ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}
