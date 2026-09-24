import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "@internal/node-admin";
import type { ComponentProps, JSX } from "react";

/**
 * The shadcn Tooltip, in the site's Base UI split form (`Tooltip` >
 * `TooltipTrigger` + `TooltipContent`) — the same wrapping the other `ui/`
 * modules apply (see `dropdown-menu.tsx`), so callers never import
 * `@base-ui/react` directly.
 *
 * Split rather than the old self-contained `content` wrapper because the
 * trigger is sometimes the whole surface: a sidebar row is a `Link` that is
 * also a drag source and a context-menu trigger, and the way a tooltip hangs
 * off such an element WITHOUT becoming the third wrapper that kills one of
 * its gestures is Base UI's `render` prop — the trigger merges its handlers
 * onto the caller's own element, so the `Link` stays the `Link`.
 */
export function TooltipProvider({ delay = 0, ...props }: ComponentProps<typeof BaseTooltip.Provider>): JSX.Element {
  return <BaseTooltip.Provider delay={delay} {...props} />;
}

export function Tooltip(props: ComponentProps<typeof BaseTooltip.Root>): JSX.Element {
  return <BaseTooltip.Root {...props} />;
}

/** Props pass straight through, so Base UI's `render` prop reaches callers. */
export function TooltipTrigger(props: ComponentProps<typeof BaseTooltip.Trigger>): JSX.Element {
  return <BaseTooltip.Trigger {...props} />;
}

/**
 * The popup. `text-body`, not `text-detail` (operator call, 2026-09-24): a
 * step up the scale, because this text sits on top of the thing it explains
 * and multi-line row content read as noise at 13. And the popup being a real
 * element in the page is the whole reason the row tooltips switched from
 * native `title` — the browser paints native tooltips at the SYSTEM font
 * size, so page zoom (ctrl +/-) grew the rows and left the tooltip behind.
 */
export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof BaseTooltip.Popup> & { sideOffset?: number }): JSX.Element {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner sideOffset={sideOffset}>
        <BaseTooltip.Popup
          className={cn(
            "z-50 max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-body text-popover-foreground shadow-md",
            "origin-[var(--transform-origin)] transition-[transform,opacity] data-[ending-style]:opacity-0",
            "data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
