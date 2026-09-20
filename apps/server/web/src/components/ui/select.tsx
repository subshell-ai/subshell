import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "@internal/node-admin";
import { Check, ChevronDown } from "lucide-react";
import type { JSX } from "react";

/**
 * Select on Base UI parts (migrated from Radix `Select`; export names
 * unchanged). Content split into `Portal > Positioner > Popup > List`.
 *
 * IMPORTANT vs the Radix era: Base UI's `Value` renders the RAW value
 * string, not the selected item's label — roots whose labels differ from
 * values must pass `items={[{ value, label }]}` to the Root. Call sites
 * (preset editor, subshell pickers) do; plain value-equals-label selects
 * don't need it.
 */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props): JSX.Element {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon render={<ChevronDown className="h-4 w-4 opacity-50" />} />
    </SelectPrimitive.Trigger>
  );
}

export interface SelectContentProps
  extends Pick<SelectPrimitive.Positioner.Props, "side" | "align" | "alignOffset" | "sideOffset">,
    SelectPrimitive.Popup.Props {
  /** Kept from the Radix-era API. `"popper"` (the old app default) hangs the
   * list under the trigger; `"item-aligned"` centers it on the selected
   * item. Maps to Base UI's `alignItemWithTrigger` on the Positioner. */
  position?: "popper" | "item-aligned";
}

export function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  side,
  alignOffset,
  sideOffset,
  ...props
}: SelectContentProps): JSX.Element {
  return (
    <SelectPrimitive.Portal>
      {/* Positioning props are declared, destructured, and forwarded HERE —
          Base UI anchors on the Positioner, not the Popup. align="start"
          matches the Radix default the app had. */}
      <SelectPrimitive.Positioner
        align={align}
        side={side}
        alignOffset={alignOffset}
        sideOffset={position === "popper" ? (sideOffset ?? 4) : sideOffset}
        alignItemWithTrigger={position === "item-aligned"}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "max-h-96 overflow-hidden rounded-md border bg-popover text-popover-foreground opacity-100 shadow-md transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
            // Popper mode keeps the old trigger-width parity.
            position === "popper" && "min-w-[var(--anchor-width)]",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props): JSX.Element {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
