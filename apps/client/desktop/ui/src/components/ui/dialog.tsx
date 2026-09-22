/**
 * The app's one modal (operator ruling 2026-09-22: actions confirm in a
 * DIALOG, not as another pane rendered inside the panel they belong to).
 *
 * It is a fixed overlay with a class-positioned card and no measuring
 * primitive: the bundle's CSP blocks style ATTRIBUTES, which is what sinks
 * the positioning libraries (`confirm-panel.tsx` records the measurement),
 * and none is needed — the panel centers itself. Escape and a backdrop press
 * close it through `onClose`; for a confirmation that IS the cancel, which is
 * the safe direction a native dialog teaches everyone. `aria-modal` and the
 * labelled `role=dialog` say what it is; the accept button that shares its
 * words with the button behind it stays tellable-apart because everything a
 * test or a screen reader reaches for lives inside this one labelled thing.
 *
 * The consequence messages this app confirms with are several sentences
 * long; they render IN the dialog (it carries its own title), so the panel's
 * original argument against modals — re-reading the text behind a dismiss-
 * first wall — does not apply to what is being said inside the dialog now.
 */
import { type ReactElement, type ReactNode, useEffect } from "react";

export function Dialog(props: {
  /** Names the dialog to assistive tech AND, unless `heading` replaces it, renders as its heading. */
  title: string;
  onClose: () => void;
  /** Default: `title` set in card-heading style. Pass a node to restyle (the confirm panel keeps its warning voice). */
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
