import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type ActionItem, ActionsMenu } from "@/components/actions-menu";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The card shell every entity list shares: the whole card is a link to the
 * entity's primary destination, and its actions live in an overflow menu
 * floated over the top-right corner, outside the link so opening it doesn't
 * navigate.
 *
 * The trigger is `h-7 w-7`, and the title reserves `pr-7` so it never slides
 * underneath it — both live here so the two can only ever drift together.
 */
export function EntityCard({
  to,
  params,
  title,
  description,
  items,
  menu,
  accessory,
  headerExtra,
  children,
  className,
}: {
  /** In-app destination, e.g. `/workspaces/$id` */
  to: string;
  /** Params for `to` */
  params?: Record<string, string>;
  /** Entity name */
  title: string;
  /**
   * Subtitle. Pass null (or an empty string) to show the middot placeholder
   * that keeps same-grid cards level; omit it entirely for entities that
   * have no subtitle at all.
   */
  description?: string | null;
  /** Actions for this entity's overflow menu (mutually exclusive with `menu`) */
  items?: ActionItem[];
  /**
   * A ready-made menu for the top-right slot instead of an `items` list —
   * for entities whose menu carries its own state (a subshell menu with
   * dialogs and lifecycle mutations). Occupies the same floated slot.
   */
  menu?: ReactNode;
  /** Optional chip beside the title (a harness badge, an activity chip) */
  accessory?: ReactNode;
  /** Optional extra header line under the description (e.g. a working dir) */
  headerExtra?: ReactNode;
  /** Optional CardContent body */
  children?: ReactNode;
  /** Extra classes for the root wrapper — e.g. a drag-over ring from the workspaces grid (spec 2026-09-03 sidebar-quickadd §5d). */
  className?: string;
}) {
  // Either menu flavour occupies the same floated slot; with neither, the
  // card has no menu at all and the slot collapses.
  const menuSlot = menu ?? (items ? <ActionsMenu label={title} items={items} /> : null);
  return (
    <div className={cn("relative h-full", className)}>
      {/* The one link boundary for entity grids: `to`/`params` are plain
          strings here, checked by nothing but the app at runtime — every
          other menu or button reaches routes through the caller's own typed
          `navigate`/`Link` instead. */}
      <Link to={to as never} params={params as never} className="block h-full">
        <Card className="h-full overflow-hidden transition-colors hover:border-primary/60">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              {accessory ? (
                <>
                  <CardTitle className="min-w-0 truncate text-base" title={title}>
                    {title}
                  </CardTitle>
                  <div className="flex shrink-0 items-center gap-2 pr-7">{accessory}</div>
                </>
              ) : (
                <CardTitle className="truncate pr-7 text-base" title={title}>
                  {title}
                </CardTitle>
              )}
            </div>
            {description !== undefined && <CardDescription className="truncate">{description || "·"}</CardDescription>}
            {headerExtra}
          </CardHeader>
          {children && <CardContent className="space-y-1 text-muted-foreground text-xs">{children}</CardContent>}
        </Card>
      </Link>

      {/* The menu — `items`-driven or a caller-built one — floats outside
          the link so opening it never navigates. */}
      {menuSlot && <div className="absolute top-3 right-2 z-10">{menuSlot}</div>}
    </div>
  );
}
