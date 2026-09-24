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
 * Arrow placement, keyed off `data-side` — the side the popup ACTUALLY
 * rendered on, which is the trigger's direction after any flip near a
 * viewport edge; a `side` prop in a class name would leave the tip pointing
 * at nothing once flipped. Per side: a negative inset centers the 8px box ON
 * the popup edge facing the trigger, and exactly the two square edges that
 * meet at the trigger-facing corner of the `rotate-45` diamond are bordered,
 * so the outline lands on the faces and the half buried in the popup shows
 * nothing. Base UI's inline `arrowStyles` set only the along-edge coordinate
 * (`useAnchorPositioning`), never the cross-edge inset, so inline style and
 * these classes can only ever meet without conflict.
 */
const ARROW = cn(
  "absolute size-2 rotate-45 border-border bg-popover",
  "data-[side=right]:-left-1 data-[side=right]:border-b data-[side=right]:border-l",
  "data-[side=left]:-right-1 data-[side=left]:border-t data-[side=left]:border-r",
  "data-[side=top]:-bottom-1 data-[side=top]:border-r data-[side=top]:border-b",
  "data-[side=bottom]:-top-1 data-[side=bottom]:border-t data-[side=bottom]:border-l",
);

/**
 * The popup. `text-body`, not `text-detail` (operator call, 2026-09-24): a
 * step up the scale, because this text sits on top of the thing it explains
 * and multi-line row content read as noise at 13. And the popup being a real
 * element in the page is the whole reason the row tooltips switched from
 * native `title` — the browser paints native tooltips at the SYSTEM font
 * size, so page zoom (ctrl +/-) grew the rows and left the tooltip behind.
 *
 * `side` defaults to Base UI's own ("top"); `arrow` draws the tip at the
 * popup's edge pointing back at the trigger (operator ask, 2026-09-24, for
 * the rail's rows — beside the row is where the rail's own tooltip belongs,
 * and the arrow says which row is speaking). The tip is `bg-popover` with
 * only the two trigger-facing edges bordered, so it reads as a point grown
 * out of the popup and not a diamond laid over it.
 */
export function TooltipContent({
  className,
  sideOffset = 6,
  side = "top",
  arrow = false,
  children,
  ...props
}: ComponentProps<typeof BaseTooltip.Popup> & {
  sideOffset?: number;
  side?: "top" | "bottom" | "left" | "right";
  arrow?: boolean;
}): JSX.Element {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner sideOffset={sideOffset} side={side}>
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
          {arrow && <BaseTooltip.Arrow aria-hidden className={ARROW} />}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
