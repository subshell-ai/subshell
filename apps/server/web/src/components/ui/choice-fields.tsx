import type { ReactNode } from "react";

/** Keep a choice's controls beside it, with a boundary distinct from its label. */
export function ChoiceFields({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={labelledBy}
      className="my-2 flex min-w-0 flex-col gap-4 rounded-md border bg-muted/30 p-3"
    >
      {children}
    </section>
  );
}
