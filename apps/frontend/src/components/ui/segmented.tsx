import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  /** Group label announced on the fieldset (e.g. "Where to add the session") */
  ariaLabel: string;
  /** Choices, rendered in order */
  options: SegmentedOption<T>[];
  /** The currently selected value */
  value: T;
  /** Called with the option's value when one is chosen */
  onChange: (value: T) => void;
  /** Extra classes for callers with their own alignment needs */
  className?: string;
}

/**
 * A row of mutually exclusive choices — a bordered pill group where the
 * active option gets the `secondary` fill and every option carries
 * `aria-pressed`.
 *
 * The tiled/list toggle, the add-session dialog's mode switch, and the
 * split-placement picker were three hand-rolled copies of this. Buttons stay
 * real `<button type="button">`s with their option label as the accessible
 * name — e2e locates some of them by name ("New session").
 */
export function Segmented<T extends string>({ ariaLabel, options, value, onChange, className }: SegmentedProps<T>) {
  return (
    <fieldset className={cn("flex min-w-0 items-center rounded-md border p-0.5", className)} aria-label={ariaLabel}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
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
