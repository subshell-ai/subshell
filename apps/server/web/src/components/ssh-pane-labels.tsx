import { SquareTerminal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { sshForwardWireLine } from "@/lib/ssh-forwards";
import type { SubshellView } from "@/types/subshell";

/** The header sentence a non-owner of an ssh pane sees (spec 2026-10-07 §5.4). */
export const SSH_VIEW_ONLY_COPY = "Only the owner can type in this SSH subshell.";

/**
 * The ssh facts a pane header states beside its other labels: an SSH icon
 * naming what kind of pane this is, and — only for a viewer who is not the
 * owner — the one sentence explaining why the terminal takes no input from
 * them. Enforcement is NOT here: the view layer already answers a non-owner
 * with `access: "view"` for an ssh row (spec §5.4), and the terminal reads
 * exactly that (`readOnly`, subshell-terminal.tsx). An ordinary pane renders
 * nothing, including for a `view` grantee: the general view rule is not
 * restated per-surface.
 *
 * `=== true` on the flag is deliberate: a payload cached before the field
 * existed has no `ssh` key and must read as an ordinary pane.
 */
export function SshPaneLabels({ subshell }: { subshell?: SubshellView }) {
  if (subshell?.ssh !== true) return null;
  const summary = subshell.sshSummary;
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger className="inline-flex shrink-0 items-center" aria-label="SSH connection">
            <SquareTerminal className="size-3.5 text-warning" aria-hidden="true" />
          </TooltipTrigger>
          {/* Where it goes and what it opened, from the row the launch
              approved. A pane whose column predates the summary (or cannot be
              read) falls back to the plain sentence, which is still true. */}
          <TooltipContent>
            {summary === undefined ? (
              "This subshell connects to another machine over SSH."
            ) : (
              <div className="flex flex-col gap-1">
                <p className="font-mono">{summary.destination}</p>
                {summary.forwards.length === 0 ? (
                  <p className="text-muted-foreground">No port forwards</p>
                ) : (
                  summary.forwards.map((row) => (
                    <p key={`${row.kind}|${row.bindHost ?? ""}|${row.listenPort}`} className="font-mono">
                      {sshForwardWireLine(row)}
                    </p>
                  ))
                )}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {subshell.access === "view" && <span className="text-detail text-muted-foreground">{SSH_VIEW_ONLY_COPY}</span>}
    </>
  );
}
