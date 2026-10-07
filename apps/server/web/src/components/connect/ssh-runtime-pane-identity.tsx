import { Button } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConnectJourney } from "@/components/connect/connect-journey";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SSH_PANE_IDENTITY_QUERY_KEY, useSshPaneIdentity, useSshSessions } from "@/hooks/use-ssh-runtime";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
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
export function SshRuntimePaneIdentity({ subshellId, compact = false }: { subshellId: string; compact?: boolean }) {
  const [recovering, setRecovering] = useState(false);
  const identity = useSshPaneIdentity(subshellId);
  if (identity.data === null || identity.data === undefined || identity.isError) return null;
  const line = identity.data;
  return (
    <span
      className={
        compact
          ? "inline-flex max-w-full flex-wrap items-center rounded-md bg-terminal-strip/85 px-2 py-1 text-detail text-muted-foreground backdrop-blur-sm"
          : "text-detail text-muted-foreground"
      }
    >
      SSH ·{" "}
      <span className="max-w-full truncate font-mono" title={destinationLabel(line)}>
        {destinationLabel(line)}
      </span>
      {!compact && <> · via {line.connectingNodeName ?? "a machine since removed"}</>}
      {line.status === "lost" && " · connection lost"}
      {line.status === "closed" && " · closed"}
      {line.status !== "active" && (
        <Button variant="link" size="sm" onClick={() => setRecovering(true)}>
          Reconnect
        </Button>
      )}
      {recovering && <PaneRecovery sessionId={line.sessionId} onClose={() => setRecovering(false)} />}
    </span>
  );
}

function PaneRecovery({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const sessions = useSshSessions();
  const client = useQueryClient();
  const session = sessions.data?.sessions.find((row) => row.id === sessionId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Reconnect to SSH host</DialogTitle>
        <DialogDescription>
          Your pane and workspace stay open. Reconnecting restores panes still running on the host.
        </DialogDescription>
        {sessions.isLoading && <p className="text-detail">Loading connection…</p>}
        {sessions.isError && (
          <Button variant="outline" onClick={() => void sessions.refetch()}>
            Retry
          </Button>
        )}
        {session && session.connectingNodeId !== null && (
          <ConnectJourney
            prefill={{ nodeId: session.connectingNodeId, alias: session.alias }}
            requiredTarget={{ host: session.host, port: session.port, user: session.user }}
            onConnected={() => {
              void client.invalidateQueries({ queryKey: SSH_PANE_IDENTITY_QUERY_KEY });
              void client.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
              onClose();
            }}
          />
        )}
        {!sessions.isLoading && !sessions.isError && (!session || session.connectingNodeId === null) && (
          <p className="text-detail text-muted-foreground">
            The connecting machine is no longer available. Choose another machine from New subshell to reach this host.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
