import { Button } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { MobileNav } from "@/components/mobile-top-bar";
import { useIsStackedHeader } from "@/hooks/use-is-stacked-header";

/**
 * The header bar of a full-height detail page: the nav-drawer trigger, a
 * back control to the owning list, a truncated title (plus an optional muted
 * subtitle — the subshell's working directory), and page actions on the right.
 *
 * The subshell page and the workspace header spelled this bar out twice —
 * down to the same phone-chrome comment — so it lives here once. The back
 * control is a `Button render={<Link/>}` (the house idiom): an anchor
 * wrapped around a button would announce a link containing a button.
 *
 * On a phone (below the tiling width on a touch pointer — see
 * `useIsStackedHeader()`) a single flex row cannot hold chrome + title +
 * subtitle + badges + menu — the title truncated to nothing. The bar then
 * reflows to two rows: row 1 is chrome and actions, then the title (small,
 * bold) with the subtitle (xs, muted) stacked under it — each gets the full
 * width to read. A DESKTOP window (fine pointer) always keeps the single
 * row — the pointer is the desktop signal — with the title over the subtitle
 * as a two-line block the chrome and actions flank.
 */
export function DetailBackHeader({
  to,
  backLabel,
  title,
  subtitle,
  actions,
  hideBack = false,
}: {
  /** In-app destination of the back control, e.g. `"/"` or `"/workspaces"` */
  to: string;
  /** `aria-label` of the back control, e.g. "Back to subshells" */
  backLabel: string;
  /** Title content, truncated at the width the actions leave over */
  title: ReactNode;
  /** Muted one-liner beside (wide) or under (phone) the title, e.g. a path */
  subtitle?: ReactNode;
  /** Right-aligned page controls (badges, menus, find bars) */
  actions?: ReactNode;
  /**
   * Drop the back control from the chrome row. The subshell page sets it
   * while the phone Find bar is open — the bar needs the arrow's width and
   * navigating away is not what the user is doing mid-search (the ✕ exits).
   */
  hideBack?: boolean;
}) {
  const stacked = useIsStackedHeader();
  const chrome = (
    <>
      {/* On phones the nav hamburger rides in this bar rather than a second
          chrome row above it — every row here is terminal rows.
          MobileNav renders nothing on desktop. */}
      <MobileNav />
      {!hideBack && (
        <Button variant="ghost" size="icon" aria-label={backLabel} render={<Link to={to as never} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      )}
    </>
  );
  if (!stacked) {
    return (
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        {chrome}
        {/* Two lines inside ONE row: the title over the muted subtitle, the
            chrome and actions vertically centred beside the block. Sharing a
            line squeezed the title to a few characters in a narrow window;
            the column gives each the row's full height to read. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-w-0 shrink truncate">{title}</div>
          {subtitle ? <div className="min-w-0 truncate text-detail text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions}
      </header>
    );
  }
  return (
    <header className="flex shrink-0 flex-col gap-0.5 border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {chrome}
        <div className="flex-1" />
        {actions}
      </div>
      {/* Stacked, not sharing a line: even alone, title + path do not fit a
          phone width readably — the path gets its own line under the title. */}
      <div className="flex min-w-0 flex-col">
        <div className="min-w-0 shrink truncate font-strong text-sm">{title}</div>
        {subtitle ? <div className="min-w-0 truncate text-detail text-muted-foreground">{subtitle}</div> : null}
      </div>
    </header>
  );
}
