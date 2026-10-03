import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Fact } from "@internal/node-admin";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";

export function BackupWorkflow({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  // Replace the pane DOM so a navigation click cannot submit the newly mounted form.
  return (
    <Card key={title} className="flex max-h-[calc(100dvh-16rem)] flex-col">
      <CardHeader className="shrink-0">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-6 overflow-y-auto text-body">{children}</CardContent>
      <CardFooter className="flex shrink-0 justify-between gap-3 border-t bg-card pt-4">{footer}</CardFooter>
    </Card>
  );
}

export function BackupProgress({
  finished,
  title,
  description,
  children,
}: {
  finished: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        {finished ? (
          <CheckCircle2 className="size-6 shrink-0 text-primary" aria-hidden="true" />
        ) : (
          <LoaderCircle className="size-6 shrink-0 animate-spin text-primary" aria-hidden="true" />
        )}
        <h3 className="font-strong text-card-title">{title}</h3>
      </div>
      <p className="text-body text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}

export function BackupFacts({ rows }: { rows: { label: string; value: string; copy?: boolean }[] }) {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-4 text-body sm:grid-cols-2">
      {rows.map(({ label, value, copy }) => (
        <Fact key={label} label={label}>
          {copy ? (
            <CopyCommandRow text={value} label={label.toLowerCase()} />
          ) : (
            <span className="break-words">{value}</span>
          )}
        </Fact>
      ))}
    </dl>
  );
}
