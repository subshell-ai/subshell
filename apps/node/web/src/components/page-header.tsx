import type { ReactNode } from "react";

/**
 * A page's title line. Mirrors the control-plane SPA's `PageHeader` shape
 * (title, one muted subtitle, an optional trailing action) so a card moved
 * between the two surfaces reads the same — but standalone, because the SPA's
 * carries desktop-chrome and mobile-drawer branches this dashboard never needs.
 */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-strong text-foreground text-heading">{title}</h1>
        {subtitle && <p className="mt-0.5 text-detail text-muted-foreground">{subtitle}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </header>
  );
}
