import { cn } from "@internal/node-admin";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

/**
 * The two shapes a sticky workspace error takes: `bar` sits inline inside a
 * pane/tab column (the strip under the tab row), `floating` hovers over the
 * dock tiles so it never steals layout from panels mid-drag.
 */
const errorBannerVariants = cva("flex items-center bg-terminal-strip text-detail", {
  variants: {
    variant: {
      bar: "justify-between gap-2 border-b px-3 py-1.5",
      floating: "fixed top-16 left-1/2 z-[110] -translate-x-1/2 rounded-md border px-3 py-1.5 shadow-lg",
    },
    tone: {
      danger: "border-destructive text-destructive",
      // Amber, deliberately NOT destructive: the break-glass hatch is a
      // warned-about operator state, not a request failure.
      warning: "border-amber-500/70 text-amber-600 dark:text-amber-400",
    },
  },
  defaultVariants: {
    variant: "bar",
    tone: "danger",
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
export function ErrorBanner({ variant = "bar", tone, message, action, className }: ErrorBannerProps) {
  return (
    <div role="alert" className={cn(errorBannerVariants({ variant, tone }), className)}>
      <span className="min-w-0">{message}</span>
      {action != null && <span className={variant === "floating" ? "ml-2 shrink-0" : "shrink-0"}>{action}</span>}
    </div>
  );
}
