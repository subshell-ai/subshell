import { Button, type ConfirmOptions, setConfirmHandler } from "@internal/node-admin";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Hosts the single confirmation dialog behind `confirmAction`.
 *
 * Mount once at the app root. The dialog is modal, so prompts are inherently
 * one at a time — a second ask can't be initiated while one is on screen.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<ConfirmOptions | null>(null);
  // The resolver for the on-screen prompt, kept in a ref so the settle
  // callbacks read the live one without being rebound on every render.
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  // The last prompt shown. `shown` goes null the instant an action resolves,
  // but Radix keeps the dialog mounted through its close animation — reading
  // the wording from here keeps it from blanking to a bare "Confirm" as it
  // fades. Only ever read while a prompt is closing (never while open).
  const lastRef = useRef<ConfirmOptions | null>(null);
  useEffect(() => {
    if (shown) lastRef.current = shown;
  }, [shown]);
  const view = shown ?? lastRef.current;

  const open = useCallback((options: ConfirmOptions): Promise<boolean> => {
    // Belt-and-braces: a re-ask while one is open cancels the orphaned
    // prompt rather than leaving its caller awaiting forever.
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setShown(options);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setShown(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => {
    const previous = setConfirmHandler(open);
    // Restore rather than clear, so a remount (HMR) never unregisters its own
    // replacement and silently drop every prompt onto the fail-closed path.
    return () => {
      setConfirmHandler(previous);
    };
  }, [open]);

  return (
    <>
      {children}
      <Dialog open={shown !== null} onOpenChange={(next) => !next && settle(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{view?.title}</DialogTitle>
            {view?.description && <DialogDescription>{view.description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button variant={view?.danger ? "destructive" : "default"} onClick={() => settle(true)}>
              {view?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
