import { Button } from "@internal/node-admin";
import type { ComponentProps, JSX } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An icon `Button` that carries an in-page tooltip, the way the rest of the app
 * explains itself.
 *
 * The sidebar's chrome controls (the eye that hides a section, the + that adds
 * one, the chevron that folds every group) are single glyphs, so the button's
 * NAME is the whole explanation. It was a native `title`; that moved to this
 * popup for the reason every rail tooltip moved — the browser paints a native
 * title at the SYSTEM font size, so page zoom grows the chrome and leaves the
 * explanation behind (the row tooltips, 2026-09-24). `aria-label` stays on the
 * button for screen readers; the `title` is gone so the two mechanisms never
 * both fire on one hover.
 *
 * `render` on the trigger, not a wrapper: the Button must stay the focusable,
 * clickable element (the merge carries its `onClick`/`disabled`), with the
 * tooltip hanging off it rather than around it — the same shape `SubshellNodeGroup`
 * uses for its header.
 */
export function TippedIconButton({
  tooltip,
  children,
  ...buttonProps
}: ComponentProps<typeof Button> & { tooltip: string }): JSX.Element {
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger render={<Button aria-label={tooltip} {...buttonProps} />}>{children}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
