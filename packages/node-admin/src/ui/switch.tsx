import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../lib/utils";

/**
 * Toggle switch on Base UI's `Switch` parts. The Root renders a `<span>`
 * (not a native input), so disabled styling rides `data-disabled:` instead of
 * the dead `disabled:` variant; state attrs are `data-checked`/`data-unchecked`
 * (Base UI) where Radix used `data-[state=...]`.
 *
 * A DISABLED switch must never read as merely OFF (operator ruling
 * 2026-09-30): "you may not touch this yet" is a different fact from "this is
 * off", and the old one-step dim blurred exactly there. Disabled therefore
 * OFF rides the neutral light gray (`muted-foreground` at half) and ON the
 * primary purple; DISABLED recedes to the dark input track - inert, sunk,
 * unmistakably not the one you are looking to flip (operator ruling
 * 2026-09-30, after a swap test: the same three colors, read better with
 * disabled wearing the recessed one). An earlier dim-only treatment blurred
 * disabled and off into one sight; the requirements amber and a dashed
 * outline were both refused before the colors landed here.
 *
 * The `!` is load-bearing, not a shortcut: Tailwind sorts these rules so the
 * checked/unchecked track colors land AFTER the disabled rule in the sheet,
 * and without the weight they silently repaint every disabled switch (which
 * is always also checked-or-unchecked) back to a normal state's color -
 * measured in the built CSS.
 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-checked:bg-primary data-disabled:bg-input! data-unchecked:bg-muted-foreground/50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}
