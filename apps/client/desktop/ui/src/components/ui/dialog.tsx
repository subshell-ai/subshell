/**
 * The app's one modal (operator ruling 2026-09-22: actions confirm in a
 * DIALOG, not as another pane rendered inside the panel they belong to).
 *
 * The class-positioned card respects the bundled page's CSP. Outside clicks
 * leave it open; each caller supplies a Close or Cancel button. Escape calls
 * `onClose`, which callers may guard while an operation is running.
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
    <div role="presentation" className="bg-background/70 fixed inset-0 z-50 flex items-center justify-center p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-card w-full max-w-md rounded-lg border border-border p-4 shadow-lg"
      >
        {heading ?? <p className="font-strong text-label">{title}</p>}
        <div className="mt-3 text-body [&_p]:text-body [&_ul]:text-body">{children}</div>
      </div>
    </div>
  );
}
