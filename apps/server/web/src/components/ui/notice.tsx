import { cn } from "@internal/node-admin";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** Persistent consequences stay visible without announcing an error on dialog open. */
export function WarningNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning p-3 text-body text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

export function ErrorNotice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("m-0 text-destructive text-detail", className)}>
      {children}
    </p>
  );
}
