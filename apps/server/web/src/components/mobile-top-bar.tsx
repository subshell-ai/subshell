import { useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { SheetTrigger } from "@/components/ui/sheet";
import { useHasSidebar } from "@/hooks/use-has-sidebar";
import { isDetailPath } from "@/lib/route-ids";

/** A page header's trigger for the drawer owned by the app shell. */
export function MobileNav() {
  const hasSidebar = useHasSidebar();
  if (hasSidebar) return null;
  return (
    <SheetTrigger
      aria-label="Open navigation"
      className="flex size-9 touch-manipulation items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
    >
      <Menu className="size-5" />
    </SheetTrigger>
  );
}

/**
 * Fallback chrome row for pages without their own header bar. The detail
 * pages (subshell, workspace) embed <MobileNav/> directly in their header
 * instead — one row, not two — so the bar stays out of their way entirely.
 * Matched on pathname because these are the only routes nested under those
 * prefixes (the lists live at `/` and `/workspaces`). Safe-area top padding
 * lives on the shell (`__root.tsx`), not here.
 */
export function MobileTopBar() {
  const location = useLocation();
  if (isDetailPath(location.pathname)) return null;

  return (
    <header className="flex shrink-0 items-center border-border border-b bg-card px-3 py-2">
      <MobileNav />
    </header>
  );
}
