// Copied from apps/server/web/src/components/ui/switch.tsx — verbatim except the
// `cn` import path. Kept a copy rather than a shared package for now, so the
// extraction is a straight move and a diff between the two is the drift signal.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";

/**
 * Toggle switch on Base UI's `Switch` parts. The Root renders a `<span>`
 * (not a native input), so disabled styling rides `data-disabled:` instead of
 * the dead `disabled:` variant; state attrs are `data-checked`/`data-unchecked`
 * (Base UI) where Radix used `data-[state=...]`.
 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-checked:bg-primary data-unchecked:bg-input data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}
