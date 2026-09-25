import { Button, cn } from "@internal/node-admin";
import { Fragment, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** One choice in a {@link Segmented} control. */
export interface SegmentedOption<T extends string> {
  /** Value reported through `onChange` when this option is chosen */
  value: T;
  /** Visible label — also the button's accessible name, so e2e names come from here */
  label: ReactNode;
  /** Optional leading icon node (passed through verbatim, class included) */
  icon?: ReactNode;
  /** Accessible-name override for icon-forward options (e.g. "Tiled view") */
  ariaLabel?: string;
  /**
   * Hover/focus explanation for this option, rendered as the app's own
   * styled tooltip (opt-in: options without one render byte-identical to
   * the pre-tooltip control). Exists for icon-only groups — the rail's view
   * switch — where the accessible name has no visible counterpart. A
   * deliberate second line of the rail's 2026-09-24 decision: in-page
   * popups scale with zoom, native `title`s do not.
   */
  tooltip?: ReactNode;
}

export interface SegmentedProps<T extends string> {
  /** Group label announced on the fieldset (e.g. "Where to add the subshell") */
  ariaLabel: string;
  /** Choices, rendered in order */
  options: SegmentedOption<T>[];
  /** The currently selected value */
  value: T;
  /** Called with the option's value when one is chosen */
  onChange: (value: T) => void;
  /** Extra classes for callers with their own alignment needs */
  className?: string;
  /**
   * `true` (the default): every option takes an EQUAL share of the group's
   * width — right for a switch between named states inside a bounded row,
   * where options parked at the left edge of an otherwise empty pill read as
   * one control and dead space (operator's call, 2026-09-18).
   * `false`: the group is content-sized (`w-fit`), so a page-level tab strip
   * never stretches its tabs across the page (operator's rule, 2026-09-25;
   * design-system.md "Tab groups are content-sized").
   */
  fill?: boolean;
  /**
   * Opt-in vertical density: merges `h-6` onto every option button.
   *
   * The shared `size="sm"` table (h-8 around 16px icons) is the
   * one-size-fits-most default and is what every consumer renders today —
   * `false` (the default) stays byte-identical. `true` halves the air to the
   * 24px box the rail's cell grid already works in (operator ask 2026-09-25:
   * reduce the padding on the buttons by half). Horizontal padding is NOT
   * touched: width changes were rejected twice; `h-6` wins over the
   * variant's `h-8` because `cn` is tailwind-merge, not string concat.
   */
  dense?: boolean;
}

/**
 * A row of mutually exclusive choices — a bordered pill group where the
 * active option gets the `secondary` fill and every option carries
 * `aria-pressed`. Two shapes by `fill`: the default shares the width EQUALLY,
 * so a switch inside a bounded row reads as one control; `fill={false}` sizes
 * the group to its words, which is the shape a PAGE-level tab strip takes —
 * stretching two tab labels across the page says the tabs are data columns,
 * not choices (design-system.md, operator's rule 2026-09-25).
 *
 * The tiled/list toggle, the add-subshell dialog's mode switch, and the
 * split-placement picker were three hand-rolled copies of this. Buttons stay
 * real `<button type="button">`s with their option label as the accessible
 * name — e2e locates some of them by name ("New subshell").
 */
export function Segmented<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  className,
  fill = true,
  dense = false,
}: SegmentedProps<T>) {
  return (
    <fieldset
      className={cn("flex min-w-0 items-center rounded-md border p-0.5", !fill && "w-fit", className)}
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const buttonProps = {
          type: "button",
          size: "sm",
          // Under `fill`, every option takes an EQUAL share of the group, which
          // is what makes it read as a switch between named states rather than
          // buttons parked in a pill (2026-09-18). Without it the container is
          // `w-fit` and the options size to their words — the page-tab shape
          // (2026-09-25). `min-w-0` so a long label shrinks within its share
          // instead of pushing the group past its container. `dense` swaps
          // the sm height for the rail's 24px (twMerge resolves it against
          // the variant's h-8; horizontal px stays — see the prop's JSDoc).
          className: cn("min-w-0", fill && "flex-1", dense && "h-6"),
          variant: value === option.value ? "secondary" : "ghost",
          "aria-pressed": value === option.value,
          "aria-label": option.ariaLabel,
          onClick: () => onChange(option.value),
        } as const;
        const content = (
          <>
            {option.icon}
            {option.label}
          </>
        );
        if (option.tooltip === undefined) {
          // The untouched path. A Fragment carries the React key without
          // touching the DOM, so untold options are byte-identical.
          return (
            <Fragment key={option.value}>
              <Button {...buttonProps}>{content}</Button>
            </Fragment>
          );
        }
        // The `render`-merge idiom the rail rows use for a Link that is also
        // a drag source and a menu host: the tooltip joins the BUTTON, so
        // aria-pressed / aria-label / onClick stay on one gesture anchor.
        // The RENDERED BUTTON MUST CARRY NO CHILDREN — Base UI merges the
        // trigger's children in only when the render element has none, and
        // an explicit `null` counts as "has some": that is how the rail's
        // pills once rendered blank (pinned by the rail's icon test).
        // delay 300 — the rail's popup rhythm; a mouse sweeping the group
        // should not strobe three popups.
        return (
          <TooltipProvider key={option.value} delay={300}>
            <Tooltip>
              <TooltipTrigger render={<Button {...buttonProps} />}>{content}</TooltipTrigger>
              <TooltipContent>{option.tooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </fieldset>
  );
}
