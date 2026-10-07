import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Waypoints } from "lucide-react";
import { useRef, useState } from "react";
import { ConnectJourney } from "@/components/connect/connect-journey";
import { DesktopBrokerSetup } from "@/components/connect/desktop-broker-setup";
import { SessionsTable } from "@/components/connect/sessions-table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { useSshSessions } from "@/hooks/use-ssh-runtime";
import type { SshRuntimeSessionView } from "@/lib/ssh-runtime";

/** Secondary connection recovery and disconnect controls. Launch lives in the shared subshell form. */
export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/connections" });
  },
});

export function ConnectionsPage() {
  const sessions = useSshSessions(true);
  const [prefill, setPrefill] = useState<{ nodeId: string; alias: string } | null>(null);
  // A second Reopen while the wizard already holds this machine+alias still
  // deserves a jump: the ref keys the remount below so each request re-seeds
  // the wizard at the host step.
  const prefillSeq = useRef(0);
  const [prefillKey, setPrefillKey] = useState(0);

  const reopen = (session: SshRuntimeSessionView) => {
    if (session.connectingNodeId === null) return;
    prefillSeq.current += 1;
    setPrefill({ nodeId: session.connectingNodeId, alias: session.alias });
    setPrefillKey(prefillSeq.current);
  };

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title="SSH connections"
        subtitle="Reconnect to remote work or disconnect a host. Start new work from New subshell or a workspace’s Add pane."
      />

      <DesktopBrokerSetup />
      <Link to="/new" className="text-label underline">
        Open a subshell on an SSH host
      </Link>
      {prefill !== null && (
        <ConnectJourney
          key={prefillKey}
          prefill={prefill}
          onConnected={() => {
            setPrefill(null);
            void sessions.refetch();
          }}
        />
      )}

      <section className="space-y-2" aria-label="Your SSH connections">
        <h2 className="font-strong text-label">Connections</h2>
        {sessions.isError ? (
          <EmptyState
            icon={Waypoints}
            title="The list could not be loaded"
            description="Retry to see your recent sessions."
            actionLabel="Retry"
            onAction={() => void sessions.refetch()}
          />
        ) : (
          <SessionsTable sessions={sessions.data?.sessions ?? []} loading={sessions.isLoading} onReopen={reopen} />
        )}
      </section>
    </main>
  );
}
