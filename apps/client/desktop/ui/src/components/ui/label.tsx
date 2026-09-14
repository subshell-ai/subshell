// Copied from apps/server/web/src/components/ui/label.tsx — verbatim except the
// `cn` import path. Kept a copy rather than a shared package for now, so the
// extraction is a straight move and a diff between the two is the drift signal.
import type { LabelHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Form label. Base UI ships no standalone Label primitive (labeling lives in
 * its Field parts), so this is a plain native `<label>` carrying the same
 * styling — the documented Radix-Label replacement.
 *
 * `text-label`, not `text-sm`: a form label IS the design system's `label`
 * role, and the pair it carried — 14px at weight 600 — is not on the scale.
 * No `leading-none` either; the role's 1.5 line-height is what puts air
 * between a label and the control under it. Same change, same reason, as the
 * SPA's copy of this file.
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
