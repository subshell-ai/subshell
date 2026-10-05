import { Button } from "@internal/node-admin";
import type { SshActorSide } from "@/lib/ssh";
import type { SshTerminalFacts } from "@/lib/ssh-terminal-facts";

/**
 * The SSH chrome on a managed terminal's page: the TRUSTED identity line and
 * the human takeover/return control (spec §3: "Remote OSC titles cannot
 * replace the trusted destination label"; "Human mode blocks agent reads and
 * writes on every API/stream"). The label is assembled from the facts this
 * tab recorded at open, never from anything the pane's own output says -
 * terminal bytes are data, and identity stays outside them (spec §2).
 *
 * The honesty clause is part of the control, not a footnote (spec §2's risk
 * table: "Human takeover is mistaken for confidential input"): takeover
 * controls INPUT, and the tooltip says so, because output recorded before
 * the takeover remains in the pane's log and re-appears after a return.
 *
 * Node-offline copy is deliberately distinct from destination/auth copy:
 * "the machine that runs ssh is not talking to us" has a different remedy
 * (wake that machine) than "the destination refused" (fix the account's
 * SSH setup there), and the two arrive from different facts - `nodeOffline`
 * from the pane row, auth codes from the SSH API.
 */
export function SshPaneChrome({
  facts,
  nodeOffline,
  busy,
  onControl,
}: {
  facts: SshTerminalFacts;
  /** The connecting node has no live link: input cannot reach the destination right now. */
  nodeOffline: boolean;
  /** A control POST is in flight; the button is inert until it answers. */
  busy: boolean;
  onControl: (mode: SshActorSide) => void;
}) {
  const humanHolds = facts.controlOwner === "human";
  return (
    <>
      {/* The identity line beside the pane's own name: same detail tier the
          cross-agent marker uses, mono for the destination. */}
      <span className="text-detail text-muted-foreground">
        SSH · <span className="font-mono">{facts.destination}</span> · via {facts.nodeLabel}
      </span>
      {nodeOffline ? (
        <span className="text-amber-600 text-detail dark:text-amber-400" role="status">
          The connecting node is offline, so input cannot reach the destination. Reconnect that machine.
        </span>
      ) : (
        <span className="text-detail text-muted-foreground">{humanHolds ? "You have input" : "Agent has input"}</span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        // The act is known-refused while the node is away: the button sits
        // inert beside the copy that says so, rather than offering a call
        // that can only fail (review I-2).
        disabled={busy || nodeOffline}
        title={
          humanHolds
            ? "Hand input back to the agent. Output recorded while you held control stays visible in the pane."
            : "Takeover controls input, not history. Output recorded before the takeover stays in the pane's log."
        }
        onClick={() => onControl(humanHolds ? "agent" : "human")}
      >
        {busy ? "Working…" : humanHolds ? "Return to agent" : "Take over"}
      </Button>
    </>
  );
}
