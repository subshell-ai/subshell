import { TerminalSquare } from "lucide-react";
import type { SshRuntimeSessionView } from "@/lib/ssh-runtime";
import { destinationLabel } from "@/lib/ssh-runtime";

/**
 * The wizard's last step: WHAT to open in the chosen folder. Today the seam
 * carries exactly one entry, the terminal, and the shape is the preset
 * list's future drop-in point: the runtime gains harness/preset launch with
 * the sibling detect task, and it adds rows to this same list, same call
 * signature (`onPick(kind, id?)`), with no redesign here. Nothing is faked
 * until the server can answer for it.
 */
export function LaunchStep({
  session,
  cwd,
  busy,
  onPick,
}: {
  session: SshRuntimeSessionView;
  /** The folder chosen in the browser above this step. */
  cwd: string;
  /** A launch is in flight; the rows are inert until it answers. */
  busy: boolean;
  /** The chosen entry: `terminal` today, preset ids when the runtime offers them. */
  onPick: (kind: "terminal", id?: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="font-strong text-label">Open in this folder</p>
      {/* A real button, not a click-handler div: this is the step's only
          control, and a control has to take the keyboard. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => onPick("terminal")}
        className="w-full cursor-pointer rounded-md border p-4 text-left transition-colors hover:bg-accent disabled:pointer-events-none"
      >
        <div className="flex items-center gap-3">
          <TerminalSquare className="h-5 w-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-strong text-label">Terminal</p>
            {/* Two sentences, the quiet tier; the path above is the data this row acts on. */}
            <p className="truncate text-detail text-muted-foreground">
              An interactive shell on <span className="font-mono">{destinationLabel(session)}</span>, starting in{" "}
              <span className="font-mono">{cwd}</span>.
            </p>
          </div>
          {busy && <span className="text-detail text-muted-foreground">Opening…</span>}
        </div>
      </button>
    </div>
  );
}
