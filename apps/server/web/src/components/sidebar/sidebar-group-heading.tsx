import type { ReactNode } from "react";

/** Quiet machine/status labels shared by the workspace and subshell trees. */
export function SidebarGroupHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-1 pt-1">
      <h3
        className="min-w-0 truncate px-3 font-strong text-detail text-muted-foreground"
        style={{ fontSize: "calc(var(--text-detail) - 1px)" }}
      >
        {children}
      </h3>
      {action}
    </div>
  );
}
