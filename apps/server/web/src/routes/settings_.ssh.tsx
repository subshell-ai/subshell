import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { GrantsScreen } from "@/components/ssh/grants-screen";
import { HostPinsScreen } from "@/components/ssh/host-pins-screen";
import { PendingApprovals } from "@/components/ssh/pending-approvals";
import { sshConnectSearch } from "@/lib/ssh-connect-search";

export const Route = createFileRoute("/settings_/ssh")({
  validateSearch: sshConnectSearch,
  component: SshSettingsRoute,
});

/**
 * The SSH settings page (spec 2026-10-08 §6, §8-§9): the owner's half of the
 * agent relay - what waits for an answer, what stands granted, and which
 * destination host keys are trusted. Per-owner, not per-instance: every
 * route below is the caller's own ledger (cookie doctrine of the whole
 * `/api/ssh` surface), so this page belongs to the personal Settings group
 * and NOT behind the admin gate the `/settings/...` siblings under Server
 * Settings carry.
 *
 * The queue leads: it is the only section where a person's INACTION has a
 * deadline (a question expires in 24 h), and an unanswered approval blocks a
 * launch that is already failing fast at the pane. Machine trust is not here:
 * it is a fact about one machine, and it renders on that machine's page.
 */
function SshSettingsRoute() {
  return <SshSettingsPage connection={Route.useSearch()} />;
}

export function SshSettingsPage({ connection }: { connection?: ReturnType<typeof sshConnectSearch> } = {}) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="SSH" subtitle="Key grants, approvals, and destination trust for your keys" />
      <PendingApprovals connection={connection} />
      <GrantsScreen />
      <HostPinsScreen />
    </main>
  );
}
