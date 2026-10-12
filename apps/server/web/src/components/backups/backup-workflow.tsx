import {
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  Card as WorkflowCard,
  CardContent as WorkflowContent,
} from "@internal/node-admin";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent } from "./backup-card";

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
  // Remount panes so a navigation click cannot submit the next pane's form.
  return (
    <WorkflowCard key={title} className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <WorkflowContent className="flex flex-col gap-4 text-sm">{children}</WorkflowContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3">{footer}</CardFooter>
    </WorkflowCard>
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
    <Card>
      <CardContent className="flex flex-col gap-4 p-4" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          {finished ? (
            <CheckCircle2 className="size-6 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <LoaderCircle className="size-6 shrink-0 animate-spin text-primary" aria-hidden="true" />
          )}
          <h3 className="m-0 font-strong text-heading">{title}</h3>
        </div>
        <p className="m-0 text-body text-muted-foreground">{description}</p>
        {children}
      </CardContent>
    </Card>
  );
}

export function BackupFacts({ rows }: { rows: { label: string; value: string; copy?: boolean }[] }) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[132px_minmax(0,1fr)]">
      {rows.map(({ label, value, copy }) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 pb-2 sm:pb-0">
            <div className="flex items-start gap-2">
              <span
                className={
                  copy && label !== "Control plane URL"
                    ? "min-w-0 flex-1 break-words font-mono text-detail [overflow-wrap:anywhere]"
                    : "min-w-0 flex-1 break-words [overflow-wrap:anywhere]"
                }
              >
                {value}
              </span>
              {copy && <CopyButton text={value} label={label.toLowerCase()} />}
            </div>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function BackupError({ message, className }: { message: string; className?: string }) {
  return (
    <p role="alert" className={cn("m-0 text-detail text-warning", className)}>
      {message}
    </p>
  );
}
