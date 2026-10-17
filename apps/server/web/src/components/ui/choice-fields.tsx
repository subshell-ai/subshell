import type { ReactNode } from "react";

/**
 * Keep a choice's controls beside it, with a boundary distinct from its label.
 *
 * The panel lives inside the option's column, which for a non-last option
 * means inside the `role="radiogroup"` element: proximity is what the panel
 * exists to show, and the two placements cannot both hold for a middle option.
 * `aria-labelledby` makes it a named landmark (reachable by landmark
 * navigation), and the group's arrow keys move only between the radios, so
 * fields stay inside the group element deliberately (docs/design-system.md,
 * Dependent forms, 2026-10-17).
 */
export function ChoiceFields({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={labelledBy}
      className="my-2 flex min-w-0 flex-col gap-4 rounded-md border bg-muted/30 p-3"
    >
      {children}
    </section>
  );
}
