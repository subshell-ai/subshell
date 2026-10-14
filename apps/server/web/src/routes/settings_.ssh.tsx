import { createFileRoute } from "@tanstack/react-router";
import { SavedHostsSection } from "@/components/connect/saved-hosts-section";
import { DashboardPage } from "@/components/dashboard-page";
import { PageHeader } from "@/components/page-header";
import { sshConnectSearch } from "@/lib/ssh-connect-search";

export const Route = createFileRoute("/settings_/ssh")({
  validateSearch: sshConnectSearch,
  component: SshSettingsRoute,
});

/** Personal saved and recent destinations, scoped to the caller. */
function SshSettingsRoute() {
  return <SshSettingsPage />;
}

export function SshSettingsPage() {
  return (
    <DashboardPage>
      <PageHeader title="SSH" subtitle="Manage your saved and recent destinations." />
      <SavedHostsSection />
    </DashboardPage>
  );
}
