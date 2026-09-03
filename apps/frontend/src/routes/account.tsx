import { createFileRoute } from "@tanstack/react-router";
import { ChangePasswordCard } from "@/components/change-password-card";
import { NotificationsCard } from "@/components/notifications-card";
import { NotificationsMasterCard } from "@/components/notifications-master-card";
import { PageHeader } from "@/components/page-header";
import { PasskeysCard } from "@/components/passkeys-card";
import { ProfileCard } from "@/components/profile-card";
import { TerminalFontCard } from "@/components/terminal-font-card";

export const Route = createFileRoute("/account")({ component: AccountPage });

/**
 * Everything that configures THIS user and their devices (spec 2026-09-02
 * settings-split §1) — reached from the sidebar user menu, not the nav rail.
 * Instance-wide concerns live on /settings ("Server").
 */
function AccountPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Account" subtitle="Your profile, devices and credentials" />
      <ProfileCard />
      {/* Account-wide switch first: it gates every device, so it reads as the
          parent of the per-device opt-in below it. */}
      <NotificationsMasterCard />
      <TerminalFontCard />
      <NotificationsCard />
      {/* Self-service for ANY signed-in user (own passkeys only via the session). */}
      <PasskeysCard />
      <ChangePasswordCard />
    </main>
  );
}
