import { X } from "lucide-react";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import type { UploadEntry } from "@/hooks/use-terminal-uploads";

/**
 * Non-interactive feedback layered over the terminal: a drop target outline
 * while dragging, per-file upload progress, and a dismissible error.
 *
 * Everything is `pointer-events-none` except the error's dismiss button, so
 * the overlay never swallows terminal input.
 */
export function TerminalDropOverlay({
  isDragActive,
  entries,
  error,
  onDismiss,
}: {
  /** True while files are being dragged over the terminal */
  isDragActive: boolean;
  /** In-flight uploads, one row each (name + downscale/upload state + %) */
  entries: readonly UploadEntry[];
  /** Last upload error, or null */
  error: string | null;
  /** Clears the error */
  onDismiss: () => void;
}) {
  return (
    <>
      {isDragActive && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-primary/60 border-dashed bg-background/70 backdrop-blur-sm">
          <p className="text-sm">Drop files to upload into the working directory</p>
        </div>
      )}
      {entries.length > 0 && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex w-64 max-w-[85%] -translate-x-1/2 flex-col gap-1.5">
          <StatusPill className="static translate-x-0">
            Uploading {entries.length} file{entries.length === 1 ? "" : "s"}…
          </StatusPill>
          {entries.map((entry) => {
            const pct =
              entry.status === "uploading" && entry.total > 0
                ? Math.min(100, Math.round((entry.sent / entry.total) * 100))
                : null;
            return (
              <div
                key={entry.id}
                role="status"
                className="rounded-md border bg-background/95 px-2.5 py-1.5 text-detail shadow backdrop-blur"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">{entry.name}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {entry.status === "compressing" ? "compressing…" : pct === null ? "uploading…" : `${pct}%`}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={
                      entry.status === "compressing"
                        ? "h-full w-1/3 animate-pulse rounded-full bg-primary/60"
                        : "h-full rounded-full bg-primary"
                    }
                    style={entry.status === "compressing" ? undefined : { width: `${pct ?? 0}%` }}
                    aria-hidden
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="absolute bottom-3 left-1/2 z-20 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-md border border-destructive/40 bg-background/95 px-3 py-1.5 text-destructive text-detail shadow backdrop-blur"
        >
          <span className="truncate">{error}</span>
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss} aria-label="Dismiss upload error">
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </>
  );
}
