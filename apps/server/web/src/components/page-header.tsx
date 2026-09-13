import type { ReactNode } from "react";

export interface PageHeaderProps {
  /** Page title (h1) — a plain noun like "Subshells" or "Presets" */
  title: ReactNode;
  /** One-line description under the title */
  subtitle: ReactNode;
  /** Optional right-aligned affordance, usually the "New X" button */
  action?: ReactNode;
}

/**
 * Title + subtitle (+ optional action) block opening every list/admin page.
 *
 * The recipe was already unanimous across six pages; the component exists so
 * the next page copies it for free instead of re-typing it — and so the
 * action passes through untouched (its accessible name is e2e-pinned).
 */
export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <header className="mb-6 flex items-center justify-between">
      <div>
        <h1 className="font-bold text-2xl">{title}</h1>
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>
      {action}
    </header>
  );
}
