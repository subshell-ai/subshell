import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * One labelled fact. `mono` is for values a human copies verbatim — versions,
 * paths, command lines — where proportional digits are actively harmful.
 */
export function Fact({
  label,
  children,
  mono,
  wide,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-full" : undefined}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`mt-1 ${mono ? "break-all font-mono text-detail" : ""}`}>{children}</dd>
    </div>
  );
}

/**
 * A card of facts, laid out as the same two/three-column `<dl>` the node
 * detail page uses — the app's one established shape for "a block of things
 * that are true", so a new page of them needs no new visual vocabulary.
 */
export function FactCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">{children}</dl>
      </CardContent>
    </Card>
  );
}
