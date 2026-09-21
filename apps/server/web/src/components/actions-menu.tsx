import { Button, cn } from "@internal/node-admin";
import { Check, type LucideIcon, MoreHorizontal } from "lucide-react";
import { type JSX, type ReactNode, useRef } from "react";
import { ContextMenuRoot, ContextMenuTriggerContents } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One entry in an {@link ActionsMenu}. */
export interface ActionItem {
  /** Menu text */
  label: string;
  /** Leading icon */
  icon: LucideIcon;
  /**
   * Runs when the item is picked. Everything the item does — including
   * navigation via the router's `navigate` — belongs to the caller, so the
   * menu stays free of route knowledge and callers keep their type checking.
   */
  onSelect?: () => void;
  /** Red item styling; pair it with a `confirmAction` prompt in `onSelect` */
  destructive?: boolean;
  /**
   * Renders the item greyed and inert — for actions the caller can SEE but
   * not perform (e.g. Delete on a node shared read-only), where hiding would
   * misrepresent what the surface can do.
   */
  disabled?: boolean;
  /**
   * A toggled state, rendered as a trailing check mark: `true` checked,
   * `false` unchecked (an invisible placeholder keeps the rows aligned), and
   * `undefined` for the ordinary one-shot actions, which get no slot. The
   * check is the devices list's pin idiom, not a role change: the item still
   * acts on select, exactly like every other entry.
   */
  checked?: boolean;
  /**
   * Show this item in the compact right-click menu too (sidebar rows).
   * Context mode renders ONLY the flagged items — a deliberate curation, so
   * dialog-flavoured page actions don't crowd a 220px nav list (spec
   * 2026-09-03 amendment). Declared at the item's single definition site,
   * so the surfaces stay one list with one filter.
   */
  sidebar?: boolean;
}

/**
 * The one rendering of an `ActionItem[]` — leading icon, destructive red,
 * disabled grey — shared by both {@link ActionsMenu} modes so a ⋯ menu and a
 * right-click menu can never present the same entity's actions differently.
 */
function MenuItems({ items }: { items: ActionItem[] }): JSX.Element {
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            className={item.destructive ? "text-destructive data-highlighted:text-destructive" : undefined}
            onSelect={item.disabled ? undefined : item.onSelect}
          >
            <Icon className="h-4 w-4" />
            {item.label}
            {item.checked !== undefined && (
              <Check
                aria-hidden="true"
                className={cn("ml-auto h-4 w-4 shrink-0", item.checked ? "text-primary" : "text-transparent")}
              />
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * The overflow menu every entity card and row puts its actions behind, so
 * lists show the entity instead of a cluster of icon buttons.
 *
 * Pure presentation: it owns the trigger's look, the destructive styling,
 * and the click isolation that keeps a menu inside a clickable card from
 * navigating. Entity knowledge (endpoints, invalidation, confirms, routes)
 * belongs to the caller — see `SubshellActionsMenu` for the wrapping pattern.
 *
 * Two trigger modes share one item list: the default ⋯ button, and — when
 * `children` are passed — a right-click context menu wrapping that subtree
 * (the sidebar's recent rows, spec 2026-09-03).
 */
export function ActionsMenu({
  label,
  items,
  disabled,
  children,
}: {
  /** Entity name, used for the trigger's accessible label */
  label: string;
  items: ActionItem[];
  /** Disables the trigger, e.g. while a bulk action covers this row */
  disabled?: boolean;
  /** When present: the menu opens on RIGHT-CLICK of this subtree instead of
   * from a ⋯ button — no visible affordance is added (spec 2026-09-03). */
  children?: ReactNode;
}): JSX.Element {
  // The context-mode trigger host doubles as the positioner's anchor; unused
  // by the ⋯ button mode (a hook must run unconditionally either way).
  const anchorRef = useRef<HTMLSpanElement>(null);
  if (children) {
    // The compact surface: curated items only, anchored to the ROW (a real
    // block box — `display:contents` has no box to anchor against), opening
    // beside it at the same place for every click within the row.
    const sidebarItems = items.filter((item) => item.sidebar);
    if (sidebarItems.length === 0) return <>{children}</>;
    return (
      <ContextMenuRoot disabled={disabled}>
        <ContextMenuTriggerContents ref={anchorRef}>{children}</ContextMenuTriggerContents>
        <DropdownMenuContent
          anchor={anchorRef}
          side="right"
          align="start"
          sideOffset={6}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItems items={sidebarItems} />
        </DropdownMenuContent>
      </ContextMenuRoot>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-label={`Actions for ${label}`}
            disabled={disabled}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <MenuItems items={items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
