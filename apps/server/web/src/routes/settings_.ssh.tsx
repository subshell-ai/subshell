import { createFileRoute } from "@tanstack/react-router";
import { SavedHostsSection } from "@/components/connect/saved-hosts-section";
import { SshWizardDialog } from "@/components/connect/ssh-wizard-dialog";
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
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="SSH" subtitle="Saved destinations and destination trust" />
      <SshWizardDialog />
      <HostPinsScreen />
      <SavedHostsSection />
    </main>
  );
}
