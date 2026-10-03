import { Frame } from "@internal/assistant";
import { Card, CardContent } from "@internal/node-admin";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";

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
    <div
      key={title}
      className="flex min-h-0 flex-1 flex-col [&>div]:h-full [&_[data-slot=bar-right]]:flex-1 [&_[data-slot=bar-right]]:justify-between"
    >
      <Frame contentAlignment="start" strings={{ title, subtitle: description, problem: "" }} barRight={footer}>
        <div className="flex flex-col gap-4 text-body">{children}</div>
      </Frame>
    </div>
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
          <h3 className="font-strong text-card-title">{title}</h3>
        </div>
        <p className="text-body text-muted-foreground">{description}</p>
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
