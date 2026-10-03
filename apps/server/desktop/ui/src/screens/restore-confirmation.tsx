import { ExternalLink } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";

export function RestoreFacts({
  rows,
  copy = false,
  onOpen,
}: {
  rows: [string, string][];
  copy?: boolean;
  onOpen?: () => void;
}) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[132px_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 pb-2 sm:pb-0">
            <div className="flex items-start gap-2">
              <span
                className={
                  copy && ["Archive", "Database", "Data directory", "Configuration"].includes(label)
                    ? "min-w-0 flex-1 break-words [overflow-wrap:anywhere] font-mono text-detail"
                    : "min-w-0 flex-1 break-words [overflow-wrap:anywhere]"
                }
              >
                {value}
              </span>
              {copy &&
                ["Archive", "Control plane URL", "Database", "Data directory", "Configuration"].includes(label) &&
                value !== "Unavailable" && (
                  <CopyButton getText={() => value} copyKey={`restore-${label}`} label={label} />
                )}
              {label === "Control plane URL" && onOpen && value !== "Unavailable" && (
                <Button variant="ghost" size="icon-sm" aria-label="Open control plane" onClick={onOpen}>
                  <ExternalLink />
                </Button>
              )}
            </div>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
