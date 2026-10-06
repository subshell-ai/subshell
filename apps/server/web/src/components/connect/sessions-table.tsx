import { Button, confirmAction, errMessage } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { ArrowUpCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { useNodes } from "@/hooks/use-nodes";
import { useSshClose } from "@/hooks/use-ssh-runtime";
import { destinationLabel, type SshRuntimeSessionView } from "@/lib/ssh-runtime";

/**
 * The personal history (design §7's Connections-like list): the caller's own
 * sessions, newest first, each row naming the destination and the machine
 * that brokered it. Statuses read in user words, and the honesty sentence is
 * part of the LOST row, not a footnote: a lost session means the destination
 * is unavailable, never that the work completed. Closing ends the session;
 * launched panes keep running on the destination until ended themselves
 * (design §6), and the confirm dialog says so before the act.
 */

/** The status word a row shows beside its dot-free truth. */
const STATUS_WORDS: Record<SshRuntimeSessionView["status"], string> = {
  opening: "Opening",
  active: "Connected",
  lost: "Lost",
  closed: "Closed",
};

export function SessionsTable({
  sessions,
  loading,
  onReopen,
}: {
  sessions: SshRuntimeSessionView[];
  loading: boolean;
  /** Re-run the journey with this machine and alias pre-chosen. */
  onReopen: (session: SshRuntimeSessionView) => void;
}) {
  const nodesQ = useNodes();
  const close = useSshClose();
  const [error, setError] = useState<string | null>(null);

  const machineName = (id: string | null): string | null =>
    id === null ? null : (nodesQ.data?.nodes.find((n) => n.id === id)?.name ?? null);

  async function handleClose(session: SshRuntimeSessionView) {
    setError(null);
    const ok = await confirmAction({
      title: "Close session?",
      description: `The connection to ${destinationLabel(session)} ends. Panes you launched there keep running until you end them yourself.`,
      confirmLabel: "Close",
      danger: true,
    });
    if (!ok) return;
    try {
      await close.mutateAsync(session.id);
    } catch (err) {
      setError(errMessage(err, "The session could not be closed."));
    }
  }

  if (loading) {
    return <p className="text-detail text-muted-foreground">Loading…</p>;
  }
  if (sessions.length === 0) {
    return (
      <p className="text-detail text-muted-foreground">
        Your sessions land here after you connect. The list is yours alone.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error !== null && (
        <p role="alert" className="text-destructive text-detail">
          {error}
        </p>
      )}
      {sessions.map((s) => {
        const via = machineName(s.connectingNodeId);
        return (
          <div key={s.id} className="rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-strong text-label">{destinationLabel(s)}</span>
                <span className="block truncate text-detail text-muted-foreground">
                  {s.alias}
                  {via !== null ? ` · via ${via}` : s.connectingNodeId === null ? " · connecting machine removed" : ""}
                  {" · "}
                  {STATUS_WORDS[s.status]}
                  {" · "}
                  {new Date(s.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {(s.status === "lost" || s.status === "closed") && (
                  <Button variant="ghost" size="sm" onClick={() => onReopen(s)} title="Reopen this destination">
                    <ArrowUpCircle className="h-4 w-4" /> Reopen
                  </Button>
                )}
                {(s.status === "active" || s.status === "opening") && (
                  <Button variant="ghost" size="sm" onClick={() => void handleClose(s)} disabled={close.isPending}>
                    <XCircle className="h-4 w-4" /> Close
                  </Button>
                )}
              </span>
            </div>
            {s.status === "lost" && (
              <p className="mt-1 text-detail text-muted-foreground" role="status">
                The connection dropped. The destination is unavailable, not completed. Reopen to reconcile.
              </p>
            )}
            {s.status === "closed" && (
              <p className="mt-1 text-detail text-muted-foreground">
                The session ended. Panes launched on it keep running on the destination.
              </p>
            )}
            {s.hello !== null && (
              <p className="mt-1 truncate text-detail text-muted-foreground">
                Runtime <span className="font-mono">{s.hello.agentVersion}</span> on{" "}
                <span className="font-mono">
                  {s.hello.os}/{s.hello.arch}
                </span>
              </p>
            )}
          </div>
        );
      })}
      <p className="text-detail text-muted-foreground">
        Looking for a past pane?{" "}
        <Link to="/" className="underline underline-offset-2">
          Subshells
        </Link>{" "}
        keeps every row a session launched.
      </p>
    </div>
  );
}
