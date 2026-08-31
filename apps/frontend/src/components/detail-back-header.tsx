import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { MobileNav } from "@/components/mobile-top-bar";
import { Button } from "@/components/ui/button";

/**
 * The header bar of a full-height detail page: the nav-drawer trigger, a
 * back control to the owning list, a truncated title, and page actions on
 * the right.
 *
 * The session page and the workspace header spelled this bar out twice —
 * down to the same phone-chrome comment — so it lives here once. The back
 * control is a `Button render={<Link/>}` (the house idiom): an anchor
 * wrapped around a button would announce a link containing a button.
 */
export function DetailBackHeader({
  to,
  backLabel,
  title,
  actions,
}: {
  /** In-app destination of the back control, e.g. `"/"` or `"/workspaces"` */
  to: string;
  /** `aria-label` of the back control, e.g. "Back to sessions" */
  backLabel: string;
  /** Title content, truncated at the width the actions leave over */
  title: ReactNode;
  /** Right-aligned page controls (badges, menus, find bars) */
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
      {/* On phones the nav hamburger rides in this bar rather than a second
          chrome row above it — every row here is terminal rows.
          MobileNav renders nothing on desktop. */}
      <MobileNav />
      <Button variant="ghost" size="icon" aria-label={backLabel} render={<Link to={to as never} />}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1 truncate">{title}</div>
      {actions}
    </header>
  );
}
