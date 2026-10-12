import type { ReactNode } from "react";

/** Shared margins keep dashboard headings and cards aligned between routes. */
export function DashboardPage({ children }: { children: ReactNode }) {
  return <main className="w-full min-w-0 space-y-6 p-6">{children}</main>;
}
