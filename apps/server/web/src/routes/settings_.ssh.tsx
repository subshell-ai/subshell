import { createFileRoute } from "@tanstack/react-router";
import { SavedHostsSection } from "@/components/connect/saved-hosts-section";
import { SshWizardDialog } from "@/components/connect/ssh-wizard-dialog";
import { DashboardPage } from "@/components/dashboard-page";
import { PageHeader } from "@/components/page-header";
import { HostPinsScreen } from "@/components/ssh/host-pins-screen";
import { sshConnectSearch } from "@/lib/ssh-connect-search";

export const Route = createFileRoute("/settings_/ssh")({
  validateSearch: sshConnectSearch,
  component: SshSettingsRoute,
});

/** Personal saved destinations and destination trust, scoped to the caller. */
function SshSettingsRoute() {
  return <SshSettingsPage />;
}

export function SshSettingsPage() {
  return (
    <DashboardPage>
      <PageHeader title="SSH" subtitle="Manage your destinations and saved host keys." action={<SshWizardDialog />} />
      <SavedHostsSection />
      <HostPinsScreen />
    </DashboardPage>
  );
}
