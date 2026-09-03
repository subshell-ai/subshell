import { ContextMenu } from "@base-ui/react/context-menu";
import type { JSX, ReactNode } from "react";

/**
 * Right-click menu on Base UI's `ContextMenu` parts — the context-menu twin
 * of `ui/dropdown-menu` (house pattern: thin aliases over the primitive).
 * Its Portal/Positioner/Popup/Item parts are literally the same components
 * the dropdown wrapper exports (the module re-exports Menu's parts), so
 * `DropdownMenuContent`/`DropdownMenuItem` are reused AS-IS inside
 * ContextMenuRoot; only Root and Trigger are context-menu's own.
 * Cursor anchoring is Base UI's job — it records the contextmenu event.
 */
export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;

/**
 * Layout-transparent trigger host: `display:contents` leaves the wrapped
 * row's boxes (and the sidebar's spacing) exactly as they were — the
 * context-menu equivalent of the ⋯ button's slot, with no slot.
 */
export function ContextMenuTriggerContents({ children }: { children: ReactNode }): JSX.Element {
  return <ContextMenuTrigger render={<span className="contents" />}>{children}</ContextMenuTrigger>;
}
