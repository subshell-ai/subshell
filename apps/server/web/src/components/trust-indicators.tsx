import { cn } from "@internal/node-admin";
import { Eye, ServerCog, Users } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
  // Present so the Record over the kind stays total; `trustNoticesFor` never
  // emits this kind, so the header shows no preview icon (spec §7: the
  // header machinery is unchanged).
  preview: Eye,
};

export interface TrustIndicatorsProps {
  /** Active notices, from `trustNoticesFor`. Empty renders nothing. */
  notices: TrustNotice[];
  /** Extra classes for the row wrapper. */
  className?: string;
}

export function TrustIndicators({ notices, className }: TrustIndicatorsProps): JSX.Element | null {
  const [selected, setSelected] = useState<TrustNotice | null>(null);
  const shown = selected ? (notices.find((notice) => notice.kind === selected.kind) ?? null) : null;
  // The row unmounts the dialog when the last notice goes away, and an unmount
  // never calls onOpenChange, so the click that opened it would still be held:
  // the next share to arrive would reopen the person's dialog by itself. Clearing
  // the selection when it no longer resolves is what keeps an opened-by-tap dialog
  // closed until the next tap.
  useEffect(() => {
    if (selected && !notices.some((notice) => notice.kind === selected.kind)) setSelected(null);
  }, [notices, selected]);
  if (notices.length === 0) return null;
  return (
    // One Provider for the row: Base UI batches open/close across the
    // tooltips that share a provider, so sweeping between adjacent icons
    // behaves as one surface rather than N independent widgets.
    <TooltipProvider>
      <span className={cn("flex shrink-0 items-center gap-1", className)}>
        {notices.map((notice) => {
          const Icon = ICONS[notice.kind];
          return (
            <Tooltip key={notice.kind}>
              <TooltipTrigger
                className="inline-flex size-7 items-center justify-center text-warning"
                aria-label={notice.label}
                aria-haspopup="dialog"
                onClick={() => setSelected(notice)}
              >
                {/* The label is on the icon's own element, not only in the
                    tooltip: a screen reader that never fires a hover still has
                    to be able to reach the disclosure. */}
                <Icon className="size-3.5" aria-label={notice.label} role="img" focusable="false" />
              </TooltipTrigger>
              <TooltipContent>{notice.tooltip}</TooltipContent>
            </Tooltip>
          );
        })}
      </span>
      {/* The open notice is resolved against the CURRENT list rather than shown
          from the click: a share revoked while the dialog is open must stop being
          explained by it, or a permanent disclosure turns into a claim about an
          exposure that no longer exists. */}
      <Dialog
        open={selected !== null && shown !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subshell access</DialogTitle>
            <DialogDescription>{shown?.tooltip}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
