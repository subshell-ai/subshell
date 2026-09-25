import { Button, cn } from "@internal/node-admin";
import type { ReactNode } from "react";

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
}: SegmentedProps<T>) {
  return (
    <fieldset
      className={cn("flex min-w-0 items-center rounded-md border p-0.5", !fill && "w-fit", className)}
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          // Under `fill`, every option takes an EQUAL share of the group, which
          // is what makes it read as a switch between named states rather than
          // buttons parked in a pill (2026-09-18). Without it the container is
          // `w-fit` and the options size to their words — the page-tab shape
          // (2026-09-25). `min-w-0` so a long label shrinks within its share
          // instead of pushing the group past its container.
          className={cn("min-w-0", fill && "flex-1")}
          variant={value === option.value ? "secondary" : "ghost"}
          aria-pressed={value === option.value}
          aria-label={option.ariaLabel}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}
