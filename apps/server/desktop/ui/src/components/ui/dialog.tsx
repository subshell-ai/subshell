/**
 * The app's one modal (operator ruling 2026-09-23: Reset confirms in a
 * DIALOG over the standing section, not as a pane that replaces it — the
 * Subshell Client assistant's proven shape, ported).
 *
 * It is a fixed overlay with a class-positioned card and no measuring
 * primitive: the bundle's CSP blocks style ATTRIBUTES (`style-src` carries no
 * `'unsafe-inline'`, and the client's `no-inline-styles` test is why its
 * dialog positions from classes too), and none is needed — the panel centers
 * itself. Escape and a backdrop press close it through `onClose`; for a
 * confirmation that IS the cancel, which is the safe direction a native dialog
 * teaches everyone. `aria-modal` and the labelled `role=dialog` say what it
 * is; everything a test or a screen reader reaches for lives inside this one
 * labelled thing.
 *
 * A confirmation that must NOT be dismissible says so at `onClose`: the reset
 * chain passes a no-op while it runs, so the one running thing cannot be
 * walked away from, backdrop and Escape included.
 */
import { type ReactElement, type ReactNode, useEffect } from "react";

export function Dialog(props: {
  /** Names the dialog to assistive tech AND, unless `heading` replaces it, renders as its heading. */
  title: string;
  onClose: () => void;
  /** Default: `title` set in the heading style. Pass a node to restyle. */
  heading?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const { title, onClose, heading, children } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // The backdrop press is a MOUSE convenience over the real dismissal
    // (Escape, handled above); `presentation` is the honest role, the surface
    // carries no semantics. The Radix dismissal shape, from classes only.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal
    <div
      role="presentation"
      className="bg-background/70 fixed inset-0 z-50 flex items-center justify-center p-8"
      onClick={onClose}
    >
      {/* The press that lands on the card is not a press on the backdrop;
          the island stops the event before the dismissal sees it. Escape is
          the keyboard path, already handled by the dialog itself. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: swallows the backdrop press */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-card w-full max-w-md rounded-lg border border-border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {heading ?? <p className="font-strong text-label">{title}</p>}
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
