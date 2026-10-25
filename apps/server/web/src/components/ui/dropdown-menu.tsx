import { Menu } from "@base-ui/react/menu";
import { cn } from "@internal/node-admin";
import type { JSX } from "react";

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
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuTrigger = Menu.Trigger;

export interface DropdownMenuContentProps
  extends Pick<Menu.Positioner.Props, "side" | "sideOffset" | "align" | "alignOffset" | "anchor">,
    Menu.Popup.Props {
  /** A fullscreen viewer must contain its menus to keep them in the browser's top layer. */
  container?: Menu.Portal.Props["container"];
}

export function DropdownMenuContent({
  className,
  container,
  sideOffset = 4,
  align,
  alignOffset,
  side,
  anchor,
  ...props
}: DropdownMenuContentProps): JSX.Element {
  return (
    <Menu.Portal container={container}>
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
            // outline-none: Base UI focuses the popup itself on open (that is
            // what drives arrow-key navigation); the UA draws its default
            // focus ring around the whole menu box. The keyboard affordance
            // is the item's own data-highlighted background below — the box
            // ring is noise, the same call the item rows already make.
            //
            // max-h + overflow-y-auto clamp the popup to the viewport and let
            // it scroll within that room — the same available-height pattern
            // the Select and Combobox popups use. Without it a long menu (the
            // subshell actions menu on a phone-shaped window) runs past the
            // screen and its last items are unreachable, and a box taller
            // than the viewport cannot flip either. The popup is the scroll
            // container on purpose: Base UI's menu scrolls the highlighted
            // item into view inside its popup, so keyboard nav works in a
            // clamped menu too.
            "max-h-[var(--available-height)] min-w-[12rem] overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground opacity-100 shadow-md outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
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
        // min-h-8 (32px) + py-1 — one row grammar for every menu in the app.
        // This item backs all of them (the ⋯ menus, the dock/user/preset
        // menus, and the sidebar right-click, which reuses it as-is), so a
        // size here is the same size everywhere by construction. 32px now
        // matches the Select and Combobox rows the earlier 36px ran taller
        // than (operator freed the 36px touch call 2026-10-24); it still
        // clears the WCAG 2.5.8 24px floor.
        "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-detail outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50",
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
