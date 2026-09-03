import { Menu } from "@base-ui/react/menu";
import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * Dropdown menu on Base UI's `Menu` parts (migrated from Radix
 * `DropdownMenu`; the used export names are unchanged). Positioning lives on
 * `Positioner` (the anchored container); the styled box is `Popup`.
 *
 * `onSelect` is kept as this wrapper's app-level vocabulary: Base UI has no
 * select event, so it forwards to `onClick` — with `closeOnClick` defaulting
 * to true, the close-on-choose behavior matches Radix. The dead exports of
 * the old wrapper (Portal, Sub/SubTrigger/SubContent, Label, CheckboxItem…)
 * were dropped, not ported — no consumer used them.
 */
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export interface DropdownMenuContentProps
  extends Pick<Menu.Positioner.Props, "side" | "sideOffset" | "align" | "alignOffset" | "anchor">,
    Menu.Popup.Props {}

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  align,
  alignOffset,
  side,
  anchor,
  ...props
}: DropdownMenuContentProps): JSX.Element {
  return (
    <Menu.Portal>
      {/* Declared, destructured, forwarded to the Positioner — Base UI
          requires positioning props on this node; letting them fall through
          onto the Popup silently breaks anchoring. `anchor` likewise: pass a
          ref to override the trigger (or the context menu's virtual cursor). */}
      <Menu.Positioner
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        side={side}
        anchor={anchor}
        className="isolate z-50"
      >
        <Menu.Popup
          data-slot="menu-content"
          className={cn(
            "min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground opacity-100 shadow-md transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export interface DropdownMenuItemProps extends Menu.Item.Props {
  /** App-level "this item was chosen" callback; forwarded to Base UI's
   * `onClick` (the menu closes afterwards, matching the old Radix
   * `onSelect` default). */
  onSelect?: () => void;
}

export function DropdownMenuItem({ className, onSelect, onClick, ...props }: DropdownMenuItemProps): JSX.Element {
  return (
    <Menu.Item
      data-slot="menu-item"
      className={cn(
        // min-h-11 (44px) keeps every entry a large-enough touch target, not
        // just clickable on a mouse — the split menu is the path a touch or
        // keyboard user relies on entirely, since drag never reaches them.
        "relative flex min-h-11 cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        onSelect?.();
      }}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: Menu.Separator.Props): JSX.Element {
  return <Menu.Separator data-slot="menu-separator" className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />;
}
