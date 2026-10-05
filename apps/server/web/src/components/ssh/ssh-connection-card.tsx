import { Button, confirmAction, errMessage } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS } from "@internal/subshell-protocol";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { rememberOpenedTerminal } from "@/components/ssh/ssh-connection-editor";
import { SshGrantsDialog } from "@/components/ssh/ssh-grants-dialog";
import { useDeleteSshConnection, useOpenSshTerminal, useTestSshConnection } from "@/hooks/use-ssh";
import {
  type SshConnectionView,
  type SshTestConnectionView,
  sshDestinationLabel,
  sshErrorText,
  sshRouteLine,
} from "@/lib/ssh";

/**
 * One saved SSH connection. The route line is the page's whole reason to
 * exist (spec §3: ALWAYS show the route - "Staging · deploy@app-02 · via
 * Laptop"): the name, the destination, and the machine the ssh runs FROM,
 * because a destination reached through someone else's laptop is a different
 * fact than the same host reached from the server.
 *
 * Test here probes the STORED snapshot with the node's fixed benign probe
 * (never caller command text, spec §3); a passed:false answer is a 200 with
 * a named code, rendered as the code's shipped sentence. Open terminal hands
 * the frozen `{connectionId}` to `POST /api/ssh/terminals` - the only way to
 * reference a destination - and this tab remembers the pane's facts from the
 * answer.
 */
export function SshConnectionCard({
  conn,
  nodeLabel,
  onEdit,
}: {
  conn: SshConnectionView;
  /** The connecting node's label, resolved by the page; null while nodes are unanswered. */
  nodeLabel: string | null;
  onEdit: () => void;
}) {
  const test = useTestSshConnection();
  const openTerminal = useOpenSshTerminal();
  const del = useDeleteSshConnection();
  const navigate = useNavigate();
  const [testResult, setTestResult] = useState<SshTestConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grantsOpen, setGrantsOpen] = useState(false);

  async function onTest(): Promise<void> {
    setError(null);
    try {
      setTestResult(await test.mutateAsync({ nodeId: conn.nodeId, snapshot: conn.snapshot }));
    } catch (err) {
      setError(sshErrorText(err, "The test could not run."));
    }
  }

  async function onOpenTerminal(): Promise<void> {
    setError(null);
    try {
      const terminal = await openTerminal.mutateAsync({ connectionId: conn.id });
      rememberOpenedTerminal(conn, nodeLabel ?? "unknown node", terminal);
      void navigate({ to: "/subshells/$id", params: { id: terminal.subshellId } });
    } catch (err) {
      setError(sshErrorText(err, "The terminal could not open."));
    }
  }

  async function onDelete(): Promise<void> {
    setError(null);
    const yes = await confirmAction({
      title: "Delete SSH connection?",
      description: (
        <>
          <p>{sshRouteLine(conn, nodeLabel)}</p>
          <p className="text-detail text-muted-foreground">
            Deletes are refused while runs or terminals are active on it. Grants go with it.
          </p>
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    try {
      await del.mutateAsync(conn.id);
    } catch (err) {
      setError(errMessage(err, "The connection could not be deleted."));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        {/* Line item pattern: label over detail, differing by weight and colour. */}
        <span className="font-strong text-label">{conn.displayName}</span>
        <span className="font-mono text-detail text-muted-foreground">
          {sshDestinationLabel(conn.snapshot)} · via {nodeLabel ?? "an unknown node"}
        </span>
        <span className="text-detail text-muted-foreground">
          {conn.remoteDir ? `Remote dir ${conn.remoteDir}` : "Remote dir: destination login default"} · revision{" "}
          {conn.revision}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void onTest()} disabled={test.isPending}>
          {test.isPending ? "Testing…" : "Test"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onOpenTerminal()}
          disabled={openTerminal.isPending}
        >
          {openTerminal.isPending ? "Opening…" : "Open terminal"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setGrantsOpen(true)}>
          Grants
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void onDelete()} disabled={del.isPending}>
          Delete
        </Button>
      </div>

      {testResult ? (
        testResult.passed ? (
          <p className="text-detail text-success">Connection test passed.</p>
        ) : (
          <p role="alert" className="text-destructive text-detail">
            {SSH_ERROR_DESCRIPTIONS[testResult.code]}
          </p>
        )
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive text-detail">
          {error}
        </p>
      ) : null}

      {grantsOpen ? <SshGrantsDialog open onOpenChange={setGrantsOpen} connection={conn} /> : null}
    </div>
  );
}
