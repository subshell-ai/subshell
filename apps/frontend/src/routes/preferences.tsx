import { createFileRoute } from "@tanstack/react-router";
import { NotificationsCard } from "@/components/notifications-card";
import { NotificationsMasterCard } from "@/components/notifications-master-card";
import { PageHeader } from "@/components/page-header";
import { TerminalFontCard } from "@/components/terminal-font-card";
import { TerminalHistoryCard } from "@/components/terminal-history-card";

export const Route = createFileRoute("/preferences")({ component: PreferencesPage });

/** One labeled group of cards (a tier below the PageHeader's own title). */
function Section({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-6">
      <h2 id={id} className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {label}
      </h2>
      {children}
    </section>
  );
}

/**
 * Everything that configures the APP, split by scope (spec 2026-09-04
 * app-settings-page): server-stored preferences that follow the user to every
 * device, then the browser-local controls that exist only here. Identity and
 * credentials live on /account; instance-wide settings on /settings ("Server").
 */
function PreferencesPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6">
      <PageHeader title="Preferences" subtitle="How subshell behaves — account-wide or just on this device" />
      <Section id="prefs-account" label="Synced with your account">
        {/* Account-wide switch first: it gates every device, so it reads as the
            parent of the per-device opt-in in the section below. Keep the two
            MASTER-then-DEVICE order across sections — the pair is split by
            scope on purpose, do not "reunite" them here. */}
        <div className="space-y-6">
          <NotificationsMasterCard />
          <TerminalHistoryCard />
        </div>
      </Section>
      <Section id="prefs-device" label="This device">
        <div className="space-y-6">
          <NotificationsCard />
          <TerminalFontCard />
        </div>
      </Section>
    </main>
  );
}
