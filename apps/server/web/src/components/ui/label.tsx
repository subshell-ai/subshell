import type { LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Form label. Base UI ships no standalone Label primitive (labeling lives in
 * its Field parts), so this is a plain native `<label>` carrying the same
 * styling — the documented Radix-Label replacement.
 */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // htmlFor arrives through the props spread, which this rule cannot see
    // (it statically inspects JSX attributes); call sites pair the id.
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is in {...props}
    <label
      data-slot="label"
      className={cn(
        "font-strong text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
