import type { ReactNode } from "react";

/** Quiet machine/status labels shared by the workspace and subshell trees. */
export function SidebarGroupHeading({ children }: { children: ReactNode }) {
  return (
    <h3
      className="px-3 pt-1 font-strong text-detail text-muted-foreground"
      style={{ fontSize: "calc(var(--text-detail) - 1px)" }}
    >
      {children}
    </h3>
  );
}
