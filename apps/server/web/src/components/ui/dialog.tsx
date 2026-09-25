import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@internal/node-admin";
import { X } from "lucide-react";
import type { HTMLAttributes } from "react";

/**
 * Modal dialog on Base UI's `Dialog` parts (migrated from Radix; export
 * names unchanged). Centered modals need no Positioner — the Popup places
 * itself. Enter/exit animations ride Base UI's `data-starting-style` /
 * `data-ending-style` presence attributes instead of Radix's
 * `data-[state=...]` keyframe classes.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim opacity-100 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The scroll cap lives on an INNER wrapper, not the Popup: a scrolling Popup
 * would scroll the absolutely-positioned close button out of view with the
 * content. The wrapper's negative margin absorbs the Popup's `p-6` so the
 * scroll area spans edge-to-edge, and its own `p-6` restores the padding —
 * the Popup itself never scrolls, so the X stays pinned.
 */
export function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-[calc(100vw-1.5rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-card p-6 opacity-100 shadow-lg transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 sm:w-full sm:rounded-lg",
          className,
        )}
        {...props}
      >
        <div className="-m-6 grid max-h-[85dvh] gap-4 overflow-y-auto p-6">{children}</div>
        <DialogPrimitive.Close
          className="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // Left, always. shadcn centers a dialog header until the 640px viewport
  // breakpoint, but that tests the WINDOW, not the dialog — page zoom or a
  // narrow shell put a comfortably wide dialog back in its centered branch
  // (same trap as the footer, operator report 2026-09-25).
  return <div className={cn("flex flex-col space-y-1.5 text-left", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // Always one row, right-aligned. The shadcn stock stacks the actions on
  // narrow VIEWPORTS (`flex-col-reverse sm:flex-row`), which read as a bug
  // inside a dialog that is comfortably wide on screen: the breakpoint tests
  // the window, not the dialog (operator report, 2026-09-25).
  return <div className={cn("flex flex-row justify-end gap-2", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-strong text-heading leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}
