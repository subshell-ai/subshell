import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design-system role utilities (docs/design-system.md; spec 2026-09-14 § 3.1) are
// font-sizes by definition, but tailwind-merge only recognises t-shirt sizes — left
// unregistered, `cn("text-heading", "text-muted-foreground")` DROPS the size into the
// text-colour group's conflict. Registering them keeps size-vs-size replacement
// (text-heading yields to text-label) and size-vs-colour co-existence.
//
// The weight utilities need the same treatment: an unregistered `font-*` name
// falls into the font-FAMILY group, so `cn("font-mono", "font-strong")`
// silently evicted `font-mono` (measured, final review 2026-09-14). Registering
// them under font-weight keeps family-vs-weight co-existence and makes
// weight-vs-weight replacement work: a role weight yields to any of
// Tailwind's own weight classes, and vice versa.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-display", "text-heading", "text-label", "text-body", "text-detail", "text-caption"],
      "font-weight": ["font-strong", "font-regular"],
    },
  },
});

/**
 * Merge Tailwind classes with conditional variants (shadcn/ui convention).
 *
 * The same function as `apps/server/web/src/lib/utils.ts` — copied for the same
 * reason the primitives under `components/ui/` are, so extracting the set into
 * a shared package later is a straight move.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
