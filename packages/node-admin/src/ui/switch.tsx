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
 * keeps its full contrast and rides a THIRD track color: a neutral light
 * gray (`muted-foreground` at half), distinct from both the OFF track and
 * the ON purple. (Two cuts preceded it: the requirements amber was refused
 * - gold already means a missing requirement; the dashed outline was
 * refused too - the operator asked for a background color, and got one.)
 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-checked:bg-primary data-disabled:bg-muted-foreground/50 data-unchecked:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}
