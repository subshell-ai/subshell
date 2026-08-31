import { X } from "lucide-react";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";

/**
 * Non-interactive feedback layered over the terminal: a drop target outline
 * while dragging, an upload indicator, and a dismissible error.
 *
 * Everything is `pointer-events-none` except the error's dismiss button, so
 * the overlay never swallows terminal input.
 */
export function TerminalDropOverlay({
  isDragActive,
  pending,
  error,
  onDismiss,
}: {
  /** True while files are being dragged over the terminal */
  isDragActive: boolean;
  /** Number of uploads in flight */
  pending: number;
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
      {pending > 0 && (
        <StatusPill>
          Uploading {pending} file{pending === 1 ? "" : "s"}…
        </StatusPill>
      )}
      {error && (
        <div
          role="alert"
          className="absolute bottom-3 left-1/2 z-20 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-md border border-destructive/40 bg-background/95 px-3 py-1.5 text-destructive text-xs shadow backdrop-blur"
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
