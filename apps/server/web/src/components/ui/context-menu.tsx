import { ContextMenu } from "@base-ui/react/context-menu";
import type { JSX, ReactNode, Ref } from "react";

/**
 * Right-click menu on Base UI's `ContextMenu` parts — the context-menu twin
 * of `ui/dropdown-menu` (house pattern: thin aliases over the primitive).
 * Its Portal/Positioner/Popup/Item parts are literally the same components
 * the dropdown wrapper exports (the module re-exports Menu's parts), so
 * `DropdownMenuContent`/`DropdownMenuItem` are reused AS-IS inside
 * ContextMenuRoot; only Root and Trigger are context-menu's own.
 */
export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;

/**
 * The trigger host for context mode: a real `block` box (NOT
 * `display:contents` — a box-less element cannot be a position anchor).
 * Its ref is handed to the Positioner's `anchor` so the menu opens beside
 * the row at a consistent place, not at the cursor (spec 2026-09-03
 * amendment); the box wraps the row tightly, so the layout is unchanged.
 */
export function ContextMenuTriggerContents({
  children,
  ref,
}: {
  children: ReactNode;
  ref?: Ref<HTMLSpanElement>;
}): JSX.Element {
  return <ContextMenuTrigger render={<span ref={ref} className="block" />}>{children}</ContextMenuTrigger>;
}
