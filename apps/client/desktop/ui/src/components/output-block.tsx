/**
 * The CLI's own words, VERBATIM.
 *
 * `apps/client/agent` owns every operator-facing message — the tmux refusal, the
 * `loginctl enable-linger` hint, the live-pane refusal, every enrollment
 * failure — and its strings are pinned by its own tests. Re-wording them here
 * would drift; matching them with a regex would break on the next copy edit. So
 * this prints them and nothing else, in a monospace block, because they were
 * written for a terminal and read as one.
 */
import { cn } from "@/lib/cn";
import type { ActionResult } from "@/lib/ipc";

export function OutputBlock({ result }: { result: ActionResult | null }) {
  const parts: string[] = [];
  if (result?.stdout.trim()) parts.push(result.stdout.trim());
  if (result?.stderr.trim()) parts.push(result.stderr.trim());
  if (parts.length === 0) return null;

  return (
    <pre
      aria-live="polite"
      className={cn(
        "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background px-3 py-2.5",
        "font-mono text-[11.5px] leading-relaxed",
        // A failed action reads as a failure rather than as output.
        result?.ok === false && "border-destructive",
      )}
    >
      {parts.join("\n\n")}
    </pre>
  );
}
