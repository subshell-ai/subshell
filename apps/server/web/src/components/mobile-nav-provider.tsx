import { useLocation } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useHasSidebar } from "@/hooks/use-has-sidebar";

/** Keep the drawer mounted as navigation moves between page-owned headers. */
export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const sectionNavigation = useRef(false);
  const location = useLocation();
  const hasSidebar = useHasSidebar();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a URL change dismisses a page selection, but keeps section navigation visible
  useEffect(() => {
    if (sectionNavigation.current) {
      return;
    }
    setOpen(false);
  }, [location.href]);
  useEffect(() => {
    if (hasSidebar) setOpen(false);
  }, [hasSidebar]);
  return (
    <Sheet open={open} onOpenChange={setOpen} disablePointerDismissal={false}>
      {children}
      {!hasSidebar && (
        <SheetContent
          side="left"
          showClose={false}
          className="w-80 max-w-[90vw]"
          onClick={(event) => {
            const target = event.target instanceof Element ? event.target.closest("a") : null;
            // Focusing an already-open pane does not change the URL, but still
            // finishes navigation. Section links keep their subsections visible.
            if (target && !target.closest('nav[aria-label="Main sections"]')) setOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar
            className="h-full min-h-0 w-full border-r-0"
            onSectionNavigate={() => {
              sectionNavigation.current = true;
            }}
            onSectionNavigated={() => {
              sectionNavigation.current = false;
            }}
            onQuickAdd={() => setOpen(false)}
            headerEnd={
              <SheetClose
                aria-label="Close"
                className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                <X className="size-4" />
              </SheetClose>
            }
          />
        </SheetContent>
      )}
    </Sheet>
  );
}
