import { FormSectionTitle } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/components/dashboard-page";
import { DeviceNameCard } from "@/components/device-name-card";
import { McpCard } from "@/components/mcp-card";
import { MouseSamplingCard } from "@/components/mouse-sampling-card";
import { NotificationsCard } from "@/components/notifications-card";
import { NotificationsMasterCard } from "@/components/notifications-master-card";
import { PageHeader } from "@/components/page-header";
import { SwipeNavCard } from "@/components/swipe-nav-card";
import { TerminalFontCard } from "@/components/terminal-font-card";
import { TerminalHistoryCard } from "@/components/terminal-history-card";
import { TrustBannersCard } from "@/components/trust-banners-card";

export const Route = createFileRoute("/preferences")({ component: PreferencesPage });

/** One labeled group of cards (a tier below the PageHeader's own title). */
function Section({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-6">
      <FormSectionTitle as="h2" id={id}>
        {label}
      </FormSectionTitle>
      {children}
    </section>
  );
}

/**
 * Everything that configures the APP, split by scope (spec 2026-09-04
 * app-settings-page): server-stored preferences that follow the user to every
 * device, then the browser-local controls that exist only here. Identity and
 * credentials live on /account; instance-wide settings on /settings ("Instance").
 */
function PreferencesPage() {
  return (
    <DashboardPage>
      <PageHeader title="Preferences" subtitle="How subshell behaves: account-wide or just on this device" />
      {/* THE SCOPE-SPLIT EXCEPTION (Theo, 2026-09-04): notifications stay
          bundled even though the two cards are different scopes — they are
          one decision (ring anywhere? ring HERE?), and splitting them across
          sections is what confused the push debug. Master first: it gates
          every device and reads as the parent of the per-device opt-in. */}
      <Section id="prefs-notifications" label="Notifications">
        <div className="space-y-6">
          <NotificationsMasterCard />
          <NotificationsCard />
        </div>
      </Section>
      <Section id="prefs-account" label="Synced with your account">
        <div className="space-y-6">
          <McpCard />
          <TerminalHistoryCard />
        </div>
      </Section>
      <Section id="prefs-device" label="This device">
        <div className="space-y-6">
          <TerminalFontCard />
          <DeviceNameCard />
          <SwipeNavCard />
          <MouseSamplingCard />
          <TrustBannersCard />
        </div>
      </Section>
    </DashboardPage>
  );
}
