import type { LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Form label. Base UI ships no standalone Label primitive (labeling lives in
 * its Field parts), so this is a plain native `<label>` carrying the same
 * styling — the documented Radix-Label replacement.
 *
 * **`text-label`, not `text-sm`.** A form label IS the design system's `label`
 * role — the short string you scan for — and it was rendering at `body` size
 * with `strong` weight: 14/600, a pairing the scale does not contain. The
 * audit swapped the weight token and left the size alias, which is the one
 * combination `lint:design` cannot see, since `text-sm` is a legal alias of
 * `body` on its own.
 *
 * **No `leading-none`.** It made the label's box exactly its text height, so
 * a 25-callsite `space-y-2` (8px) was the entire gap between a label and its
 * input and they read as one block. The role's own 1.5 line-height gives the
 * box ~4px of breathing room on each side — the gap lands at ~12px, the grid
 * step it should have been, in the ONE place that could set it for every
 * field rather than in twenty-five wrappers.
 */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // htmlFor arrives through the props spread, which this rule cannot see
    // (it statically inspects JSX attributes); call sites pair the id.
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is in {...props}
    <label
      data-slot="label"
      className={cn("font-strong text-label peer-disabled:cursor-not-allowed peer-disabled:opacity-70", className)}
      {...props}
    />
  );
}
