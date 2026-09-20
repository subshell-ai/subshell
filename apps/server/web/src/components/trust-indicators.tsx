import { cn } from "@internal/node-admin";
import { ServerCog, Users } from "lucide-react";
import type { JSX } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import type { TrustNotice, TrustNoticeKind } from "@/lib/trust-notices";

/**
 * The PERMANENT half of the trust disclosure: one small amber icon per active
 * notice, in the subshell's chrome, with the reason on hover/focus.
 *
 * The banners fade and can be switched off; these cannot. That division is
 * deliberate. A warning that interrupts is a warning people learn to dismiss
 * reflexively, so the interruption is spent once per exposure — but the fact
 * that this pane is not private has to stay recoverable at a glance, forever,
 * because it governs a decision (what do I type here?) the user makes
 * continuously. Suppressing the banner is a choice about interruption, never
 * about disclosure.
 *
 * Amber, not red: sharing a subshell and running one on a colleague's node are
 * ordinary, intended things to do. This is "know what this is", not "something
 * is wrong".
 */
const ICONS: Record<TrustNoticeKind, typeof Users> = {
  "foreign-node": ServerCog,
  shared: Users,
};

export interface TrustIndicatorsProps {
  /** Active notices, from `trustNoticesFor`. Empty renders nothing. */
  notices: TrustNotice[];
  /** Extra classes for the row wrapper. */
  className?: string;
}

export function TrustIndicators({ notices, className }: TrustIndicatorsProps): JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {notices.map((notice) => {
        const Icon = ICONS[notice.kind];
        return (
          <Tooltip key={notice.kind} content={notice.tooltip}>
            {/* The label is on the icon's own element, not only in the
                tooltip: a screen reader that never fires a hover still has to
                be able to reach the disclosure. */}
            <Icon
              className="size-3.5 text-amber-600 dark:text-amber-400"
              aria-label={notice.label}
              role="img"
              focusable="false"
            />
          </Tooltip>
        );
      })}
    </span>
  );
}
