import { useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsWide } from "@/hooks/use-is-wide";

/**
 * The nav drawer (hamburger trigger + side sheet), self-contained so it can
 * ride in ANY top row: the shell's fallback bar on plain pages, or a page's
 * own header (session and workspace detail) where a separate chrome row
 * would cost a row of terminal. Renders nothing at/above the tiling
 * breakpoint, where the persistent sidebar already IS the navigation. Any
 * route change closes the drawer (a tap that navigates also dismisses the
 * menu, like a native drawer).
 */
export function MobileNav() {
  const wide = useIsWide();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire-on-change effect — pathname is deliberately the trigger, not a read
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  if (wide) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open navigation"
        className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Menu className="h-5 w-5" />
      </SheetTrigger>
      <SheetContent side="left" className="p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <AppSidebar forceExpanded className="w-full border-r-0" />
      </SheetContent>
    </Sheet>
  );
}

/**
 * Fallback chrome row for pages without their own header bar. The detail
 * pages (session, workspace) embed <MobileNav/> directly in their header
 * instead — one row, not two — so the bar stays out of their way entirely.
 * Matched on pathname because these are the only routes nested under those
 * prefixes (the lists live at `/` and `/workspaces`). Safe-area top padding
 * lives on the shell (`__root.tsx`), not here.
 */
export function MobileTopBar() {
  const location = useLocation();
  if (/^\/(sessions|workspaces)\/[^/]+/.test(location.pathname)) return null;

  return (
    <header className="flex shrink-0 items-center border-border border-b bg-card px-3 py-2">
      <MobileNav />
    </header>
  );
}
