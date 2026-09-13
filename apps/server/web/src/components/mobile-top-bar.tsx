import { useLocation } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useHasSidebar } from "@/hooks/use-has-sidebar";

/**
 * The nav drawer (hamburger trigger + side sheet), self-contained so it can
 * ride in ANY top row: the shell's fallback bar on plain pages, or a page's
 * own header (subshell and workspace detail) where a separate chrome row
 * would cost a row of terminal. Renders nothing wherever the shell shows its
 * persistent sidebar, which already IS the navigation — one predicate
 * (`useHasSidebar`) decides both, so the two can never both appear. Any
 * route change closes the drawer (a tap that navigates also dismisses the
 * menu, like a native drawer).
 */
export function MobileNav() {
  const hasSidebar = useHasSidebar();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire-on-change effect — pathname is deliberately the trigger, not a read
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  if (hasSidebar) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open navigation"
        className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Menu className="h-5 w-5" />
      </SheetTrigger>
      <SheetContent side="left" className="p-0" showClose={false}>
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <AppSidebar
          forceExpanded
          // `h-full min-h-0`: the panel is `fixed inset-y-0`, but a column
          // flex child is not stretched vertically, so without this the rail
          // is content-height and its footer (the account menu) falls off the
          // bottom of a phone once the nav is long enough.
          className="h-full min-h-0 w-full border-r-0"
          // The close control rides in the brand row (where the desktop rail
          // keeps its collapse chevron) — floating it at the panel's top-right
          // put it over a nav row's quick-add + on phones (2026-09-04).
          headerEnd={
            <SheetClose
              aria-label="Close"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </SheetClose>
          }
          // A quick-add dialog opened from inside the drawer would be a second
          // stacked modal — its touch scroll-lock fights the drawer's and
          // flings the dialog's scroller (e2e repro 99-repro-drawer). Dismiss
          // the drawer when one opens.
          onQuickAdd={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
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
  if (/^\/(subshells|workspaces)\/[^/]+/.test(location.pathname)) return null;

  return (
    <header className="flex shrink-0 items-center border-border border-b bg-card px-3 py-2">
      <MobileNav />
    </header>
  );
}
