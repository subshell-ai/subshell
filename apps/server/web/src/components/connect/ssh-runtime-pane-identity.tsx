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
 * marker: `detail`, muted, the destination in monospace. When the session has
 * dropped, the line says so, because a pane whose channel is gone must not
 * read as a live destination (design §6: unavailable, not completed).
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
    </span>
  );
}
