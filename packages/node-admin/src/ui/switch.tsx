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
 * keeps its full contrast and gains a DASHED outline - the inert, locked
 * glyph, in a neutral muted tone (the first cut used the requirements amber
 * and was refused: a switch is not always disabled because of a gap, and the
 * gold already means one specific thing elsewhere on screen).
 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-checked:bg-primary data-unchecked:bg-input data-disabled:outline-dashed data-disabled:outline-1 data-disabled:outline-muted-foreground/70 data-disabled:outline-offset-2",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}
