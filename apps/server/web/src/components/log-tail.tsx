import type { ReactNode } from "react";

/** Known claude-code exit codes → human labels (mirrors the harness plugin). */
const EXIT_LABELS: Record<number, string> = {
  1: "error doing work",
  5: "permissions denied",
  10: "closed-loop complete",
  11: "gate closed",
};

/** " (code 1 — error doing work)", or "" when the code is unknown. */
function exitSuffix(exitCode?: number | null): string {
  if (exitCode == null) return "";
  const label = EXIT_LABELS[exitCode];
  return ` (code ${exitCode}${label ? `, ${label}` : ""})`;
}

/** " (code 1)" without the label — the form the empty-log line has always used. */
function exitCodeOnly(exitCode?: number | null): string {
  return exitCode == null ? "" : ` (code ${exitCode})`;
}

export interface LogTailProps {
  /** Log lines, oldest first; empty renders the "no output" line */
  lines: string[];
  /** True when older output existed but was cut from the response */
  truncated?: boolean;
  /** Process exit code, shown in both the headline and the empty-log line */
  exitCode?: number | null;
  /** Action row beside the headline (Restart, Delete/Remove pane, …) */
  children?: ReactNode;
}

/**
 * The exited-subshell panel: a headline ("Subshell exited (code …)"), an action
 * row, and the pane log's tail — the only record of why a harness that died
 * before anyone attached bailed out. Scrolls; long lines wrap.
 *
 * The full-page terminal and the workspace pane each built this with the
 * same parts and slightly different completeness; this is the richer of the
 * two (unclipped scroll + exit-code suffix), and both adopt it. Callers with
 * fewer affordances simply pass fewer children.
 */
export function LogTail({ lines, truncated = false, exitCode, children }: LogTailProps) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <p className="text-muted-foreground text-sm">Subshell exited{exitSuffix(exitCode)}</p>
        {children != null && <div className="flex items-center gap-2">{children}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {lines.length > 0 ? (
          <>
            {truncated && (
              <p className="mb-2 text-detail text-muted-foreground italic">
                earlier output omitted, showing the last {lines.length} lines
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words font-mono text-detail text-muted-foreground leading-relaxed">
              {lines.join("\n")}
            </pre>
          </>
        ) : (
          <p className="font-mono text-detail text-muted-foreground">
            Exited before producing any output{exitCodeOnly(exitCode)}.
          </p>
        )}
      </div>
    </div>
  );
}
