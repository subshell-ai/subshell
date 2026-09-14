import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * Side sheet: a dialog panel sliding in from a screen edge, built on Base
 * UI's Dialog (positioning + animation only — swipe-to-close is not wired;
 * the nav drawer uses tap-outside, Escape, or the X).
 *
 * NOTE (post-migration lesson, see .migration/dialog.md): never combine the
 * Tailwind NEGATIVE prefix with a negative arbitrary value —
 * `-translate-x-[-100%]` compiles to +100%. Use bare values
 * (`-translate-x-full`) as below.
 */
export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export interface SheetContentProps extends Dialog.Popup.Props {
  /** Edge the panel slides in from (default left). */
  side?: "left" | "right";
  /**
   * Render the built-in floating Close X (default true). Hosts whose content
   * already carries header actions pass false and place their own
   * `SheetClose`: the floating X rides the panel's top-right corner at a
   * safe-area-dependent offset, and on phones that put it directly over the
   * nav drawer's quick-add + — taps on + hit the X instead (the iPhone
   * report, 2026-09-04: "the x interferes with adding a session").
   */
  showClose?: boolean;
}

export function SheetContent({
  className,
  side = "left",
  showClose = true,
  children,
  ...props
}: SheetContentProps): JSX.Element {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 opacity-100 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <Dialog.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-50 flex w-64 max-w-[85vw] flex-col bg-card shadow-lg transition-transform duration-200",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          side === "left"
            ? "left-0 border-border border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full"
            : "right-0 border-border border-l data-ending-style:translate-x-full data-starting-style:translate-x-full",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <>
            {/* Insets resolve against the padding box, so top must clear the
                safe-area inset the Popup carries (keeps the X below the notch). */}
            <Dialog.Close
              aria-label="Close"
              className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] right-3 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </>
        )}
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export function SheetTitle({ className, ...props }: Dialog.Title.Props): JSX.Element {
  return <Dialog.Title className={cn("font-strong text-heading", className)} {...props} />;
}
