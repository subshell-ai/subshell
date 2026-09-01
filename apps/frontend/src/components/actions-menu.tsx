import { type LucideIcon, MoreHorizontal } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
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
}

/**
 * The overflow menu every entity card and row puts its actions behind, so
 * lists show the entity instead of a cluster of icon buttons.
 *
 * Pure presentation: it owns the trigger's look, the destructive styling,
 * and the click isolation that keeps a menu inside a clickable card from
 * navigating. Entity knowledge (endpoints, invalidation, confirms, routes)
 * belongs to the caller — see `SessionActionsMenu` for the wrapping pattern.
 */
export function ActionsMenu({
  label,
  items,
  disabled,
}: {
  /** Entity name, used for the trigger's accessible label */
  label: string;
  items: ActionItem[];
  /** Disables the trigger, e.g. while a bulk action covers this row */
  disabled?: boolean;
}): JSX.Element {
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
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
