import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "@internal/node-admin";
import type { JSX, ReactNode } from "react";

/**
 * Hover/focus tooltip over Base UI's primitive — the same wrapping the other
 * `ui/` modules apply (see `dropdown-menu.tsx`), so callers never import
 * `@base-ui/react` directly.
 *
 * `<Tooltip>` is self-contained: it renders its own provider, trigger and
 * positioner, because every use site so far is a single icon that wants a
 * single string. Split it into parts when something needs rich content in the
 * popup, not before.
 */
export interface TooltipProps {
  /** The popup's content — usually one short sentence. */
  content: ReactNode;
  /** What the tooltip hangs off. */
  children: ReactNode;
  /** Extra classes for the trigger wrapper. */
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps): JSX.Element {
  return (
    <BaseTooltip.Provider>
      <BaseTooltip.Root>
        {/* `render` rather than a wrapper element: an extra span inside a flex
            row shifts the icon's alignment, and the trigger has to BE the
            focusable thing for keyboard users to reach the tooltip. */}
        <BaseTooltip.Trigger className={cn("inline-flex items-center", className)}>{children}</BaseTooltip.Trigger>
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner sideOffset={6}>
            <BaseTooltip.Popup
              className={cn(
                "z-50 max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-detail text-popover-foreground shadow-md",
                "origin-[var(--transform-origin)] transition-[transform,opacity] data-[ending-style]:opacity-0",
                "data-[starting-style]:opacity-0",
              )}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
