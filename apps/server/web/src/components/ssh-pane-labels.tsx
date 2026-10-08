import type { SubshellView } from "@/types/subshell";

/** The header sentence a non-owner of an ssh pane sees (spec 2026-10-07 §5.4). */
export const SSH_VIEW_ONLY_COPY = "SSH sessions take input from their owner only.";

/**
 * The ssh facts a pane header states beside its other labels: an SSH badge
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
  return (
    <>
      <span className="text-detail text-muted-foreground">SSH</span>
      {subshell.access === "view" && <span className="text-detail text-muted-foreground">{SSH_VIEW_ONLY_COPY}</span>}
    </>
  );
}
