import { Button, type ConfirmOptions, setConfirmHandler } from "@internal/node-admin";
import { useEffect, useRef, useState } from "react";

/**
 * The dashboard's confirmation dialog — the provider `confirmAction` needs.
 *
 * The shared cards (Service verbs, Repoint, maintenance) all gate a destructive
 * act behind `confirmAction`, and that imperative handle resolves only through a
 * registered handler. The control-plane SPA has a full-featured dialog; here the
 * need is exactly the shape `ConfirmOptions` describes, so this is a faithful
 * one: a title, a supporting line, a confirm and a cancel, on the shared scrim.
 *
 * The handler lives in a ref so the promise it hands `confirmAction` resolves
 * from the SAME closure the buttons call — installing a fresh handler on every
 * render would hand a stale resolver to a prompt already on screen.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [prompt, setPrompt] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    const previous = setConfirmHandler((options) => {
      setPrompt(options);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    });
    return () => {
      setConfirmHandler(previous);
    };
  }, []);

  // Escape answers exactly like Cancel — resolve false. A global listener (not
  // the alertdialog's own onKeyDown) so it works without focus management:
  // nothing else can consume Escape while a single prompt is up, and dismissing
  // never resolves true, so a stray key cannot confirm a destructive act.
  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      resolver.current?.(false);
      resolver.current = null;
      setPrompt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt]);

  const answer = (ok: boolean): void => {
    resolver.current?.(ok);
    resolver.current = null;
    setPrompt(null);
  };

  return (
    <>
      {children}
      {prompt && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is deliberately non-interactive (role=presentation); the click-away dismiss is a mouse-only convenience that resolves false, and keyboard/AT users reach the Cancel button and the Escape handler in the effect above.
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
          // A scrim click is a dismiss, the same as Escape or Cancel: it never
          // resolves true, so nothing destructive happens on an errant click.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) answer(false);
          }}
          role="presentation"
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg"
          >
            <h2 id="confirm-title" className="font-strong text-card-foreground text-label">
              {prompt.title}
            </h2>
            {prompt.description && <p className="mt-2 text-detail text-muted-foreground">{prompt.description}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => answer(false)}>
                Cancel
              </Button>
              <Button variant={prompt.danger ? "destructive" : "default"} onClick={() => answer(true)}>
                {prompt.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
