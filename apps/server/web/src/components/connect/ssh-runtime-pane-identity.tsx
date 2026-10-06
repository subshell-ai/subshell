import { useSshPaneIdentity } from "@/hooks/use-ssh-runtime";
import { destinationLabel } from "@/lib/ssh-runtime";

/**
 * The trusted identity line on a pane opened through an SSH session: the
 * destination and the machine that brokered it, read from the SERVER's rows
 * by pane id (the by-pane route), never composed from anything the pane's
 * own output claims, and never from terminal bytes. On an ordinary pane the
 * read answers the ordinary 404 and the component renders nothing.
 *
 * The tier mirrors the old managed-terminal chrome and the cross-agent
 * marker: `detail`, muted, the destination in monospace. A session that is no
 * longer standing is qualified, in either of its two ways: `connection lost`
 * for a dropped link (design §6: unavailable, not completed) and `closed` for
 * an ended one; a pane whose channel is gone must never read as a live
 * destination. A close known client-side invalidates this read (the close
 * action in use-ssh-runtime), so the qualification lands without a reload.
 */
export function SshRuntimePaneIdentity({ subshellId }: { subshellId: string }) {
  const identity = useSshPaneIdentity(subshellId);
  if (identity.data === null || identity.data === undefined || identity.isError) return null;
  const line = identity.data;
  return (
    <span className="text-detail text-muted-foreground">
      SSH · <span className="font-mono">{destinationLabel(line)}</span> · via{" "}
      {line.connectingNodeName ?? "a machine since removed"}
      {line.status === "lost" && " · connection lost"}
      {line.status === "closed" && " · closed"}
    </span>
  );
}
