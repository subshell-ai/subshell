import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The two shapes a sticky workspace error takes: `bar` sits inline inside a
 * pane/tab column (the strip under the tab row), `floating` hovers over the
 * dock tiles so it never steals layout from panels mid-drag.
 */
const errorBannerVariants = cva("flex items-center border-destructive bg-terminal-strip text-destructive text-xs", {
  variants: {
    variant: {
      bar: "justify-between gap-2 border-b px-3 py-1.5",
      floating: "fixed top-16 left-1/2 z-[110] -translate-x-1/2 rounded-md border px-3 py-1.5 shadow-lg",
    },
  },
  defaultVariants: {
    variant: "bar",
  },
});

export interface ErrorBannerProps extends VariantProps<typeof errorBannerVariants> {
  /** The failure text to show */
  message: ReactNode;
  /** Optional affordance beside the message — usually a "Dismiss" control */
  action?: ReactNode;
  /** Extra classes for callers positioning the banner in their layout */
  className?: string;
}

/**
 * Sticky error strip for workspace chrome. Both dock and tabs caught the same
 * mutation failures and rendered the same red-on-dark strip with a Dismiss
 * link; this is that recipe with the one real difference (inline bar vs
 * floating pill) as a variant, so the two surfaces can't drift further.
 */
export function ErrorBanner({ variant = "bar", message, action, className }: ErrorBannerProps) {
  return (
    <div role="alert" className={cn(errorBannerVariants({ variant }), className)}>
      <span className="min-w-0">{message}</span>
      {action != null && <span className={variant === "floating" ? "ml-2 shrink-0" : "shrink-0"}>{action}</span>}
    </div>
  );
}
