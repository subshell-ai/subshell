import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn, ExplainedButton } from "@internal/node-admin";
import { Check, ChevronDown } from "lucide-react";
import type { JSX } from "react";
import { type PickerDensity, PickerDensityContext, usePickerDensity } from "@/components/ui/picker-density";
import { POPUP_ROW_DENSITY } from "@/components/ui/popup-row";

/**
 * Select on Base UI parts (migrated from Radix `Select`; export names
 * unchanged). Content split into `Portal > Positioner > Popup > List`.
 *
 * IMPORTANT vs the Radix era: Base UI's `Value` renders the RAW value
 * string, not the selected item's label — roots whose labels differ from
 * values must pass `items={[{ value, label }]}` to the Root. Call sites
 * (preset editor, subshell pickers) do; plain value-equals-label selects
 * don't need it.
 *
 * A `density="compact"` Root sizes the sidebar trigger. Popup rows always
 * use the shared action-menu sizing.
 */
export interface SelectProps<Value = unknown> extends SelectPrimitive.Root.Props<Value> {
  /** Size the closed control; popup rows use the shared menu sizing. */
  density?: PickerDensity;
}

/** Generic over the value type so `value`/`onValueChange` infer at call
 * sites exactly as they did when `Select` was the primitive re-export. */
export function Select<Value = unknown>({ density = "default", children, ...props }: SelectProps<Value>): JSX.Element {
  return (
    <PickerDensityContext.Provider value={density}>
      <SelectPrimitive.Root {...props}>{children}</SelectPrimitive.Root>
    </PickerDensityContext.Provider>
  );
}
export const SelectGroup = SelectPrimitive.Group;
/**
 * The trigger's current-value text.
 *
 * Not a bare re-export, because it has to be able to SHRINK. The trigger is a
 * flex row, and a flex item defaults to `min-width: auto` — so a value longer
 * than the control does not wrap or ellipsis, it pushes straight past the
 * border ("Instance default (100 lines)", reported 2026-09-20). `min-w-0` is
 * what lets it shrink at all; `truncate` is what makes the overflow read as
 * deliberate.
 */
export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props): JSX.Element {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("min-w-0 truncate text-left", className)}
      {...props}
    />
  );
}

export function SelectTrigger({
  className,
  children,
  disabledReason,
  render,
  ...props
}: SelectPrimitive.Trigger.Props & { disabledReason?: string }): JSX.Element {
  const density = usePickerDensity();
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      render={(triggerProps, state) => (
        <ExplainedButton
          {...triggerProps}
          disabled={state.disabled}
          disabledReason={disabledReason}
          render={typeof render === "function" ? (buttonProps) => render(buttonProps, state) : render}
        />
      )}
      className={cn(
        "flex w-full items-center justify-between gap-2 overflow-hidden whitespace-nowrap rounded-md border border-input bg-transparent shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        // Compact triggers fit the sidebar; default triggers fit form fields.
        "h-7 py-0.5 text-detail",
        density === "compact" ? "px-2" : "px-3",
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
            "flex max-h-[min(24rem,var(--available-height))] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground opacity-100 shadow-md transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
            // Popper mode keeps the old trigger-width parity.
            position === "popper" && "min-w-[var(--anchor-width)]",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List className="min-h-0 overflow-y-auto overscroll-contain p-1">
            {children}
          </SelectPrimitive.List>
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
        "relative flex w-full cursor-default select-none items-center rounded-sm pl-2 outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50",
        POPUP_ROW_DENSITY,
        "pr-7",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
