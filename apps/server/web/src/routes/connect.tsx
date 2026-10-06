import { createFileRoute } from "@tanstack/react-router";
import { Waypoints } from "lucide-react";
import { useRef, useState } from "react";
import { ConnectJourney } from "@/components/connect/connect-journey";
import { SessionsTable } from "@/components/connect/sessions-table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { useSshSessions } from "@/hooks/use-ssh-runtime";
import type { SshRuntimeSessionView } from "@/lib/ssh-runtime";

/**
 * Connect over SSH (design 2026-10-05 §1, §7): the personal page, open to
 * every signed-in user. The journey card on top, the caller's own session
 * history below; the route holds only the reopen hand-off (the wizard's
 * prefill) and the composition. The wizard itself keeps its step state, the
 * tables keep their reads, and nothing here derives eligibility the server
 * has not already stated.
 */

export const Route = createFileRoute("/connect")({
  component: ConnectPage,
});

function ConnectPage() {
  const sessions = useSshSessions();
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
        title="Connect over SSH"
        subtitle="Start a runtime on a machine you can reach with SSH, and open panes in a folder there."
      />

      <ConnectJourney key={prefillKey} prefill={prefill} onActive={() => void sessions.refetch()} />

      <section className="space-y-2" aria-label="Your SSH sessions">
        <h2 className="font-strong text-label">Sessions</h2>
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
