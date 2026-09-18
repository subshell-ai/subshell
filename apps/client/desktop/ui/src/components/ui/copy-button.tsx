/**
 * The copy affordance, as an icon button.
 *
 * COPIED from `apps/server/web/src/components/ui/copyable-value.tsx` — the
 * lucide `Copy` that becomes a `Check`, and the thing's name carried on the
 * accessible name, so the same gesture looks the same in both halves of the
 * product (operator's call, 2026-09-14). Taken as the button ALONE rather than
 * as `CopyableValue`, because the tmux screen puts the command on a line of
 * its own with the button beside it.
 *
 * **`apps/server/desktop`'s `lib/copy-flash.ts` is deliberately NOT ported**,
 * and that is a difference in the page rather than a shortcut. There, the
 * assistant rebuilds `#content` every 1500 ms while the flash lasts 1600, so a
 * tick living in the element was thrown away after a uniformly random fraction
 * of its life — pressed, seen, gone, with nothing wrong and nothing to notice.
 * This page is React: the poll RE-RENDERS this component rather than rebuilding
 * it, so `useState` outlives exactly the interval that defeated the other app.
 * `__tests__/copy-button.test.tsx` re-renders mid-flash and asserts the tick is
 * still there, so the claim is measured rather than assumed.
 *
 * Never disabled, and that is the behaviour the tmux screen wants: its whole
 * moment is "an action is refused until you install something", and being
 * unable to copy the fix while an install is in flight would be the worst
 * possible timing.
 */
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** How long the copied/failed state stays before the button returns to rest. */
const FLASH_MS = 1600;

/** What the button is showing. `idle` is the resting copy glyph. */
type FlashState = "idle" | "copied" | "failed";

export function CopyButton(props: {
  /** The text a press puts on the clipboard. */
  value: string;
  /** What is being copied, for the accessible name — lower case, e.g. "the Homebrew command". */
  label: string;
}) {
  const { value, label } = props;
  const [state, setState] = useState<FlashState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One timer, cancelled on unmount and replaced by a second press rather than
  // left to fire against a component that is gone or to cut a newer flash
  // short.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function flash(next: Exclude<FlashState, "idle">): void {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), FLASH_MS);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      flash("copied");
    } catch {
      // The clipboard can be refused — a non-secure context, a policy — and a
      // press that flashed nothing would read as one that did not register.
      // The text stays on screen either way, which is the real fallback.
      flash("failed");
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      // Icon-only, so the state has to live on the accessible name: a check
      // glyph says nothing to a screen reader. The failed state keeps the copy
      // glyph — there is no mark for "try again" that reads as anything but a
      // second action — so the announcement is what tells the two apart.
      aria-label={
        state === "copied" ? `${label} copied` : state === "failed" ? `Could not copy ${label}` : `Copy ${label}`
      }
      onClick={() => void copy()}
    >
      {state === "copied" ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}
