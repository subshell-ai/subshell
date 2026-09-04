import { createFileRoute } from "@tanstack/react-router";
import { ChangePasswordCard } from "@/components/change-password-card";
import { PageHeader } from "@/components/page-header";
import { PasskeysCard } from "@/components/passkeys-card";
import { ProfileCard } from "@/components/profile-card";

export const Route = createFileRoute("/account")({ component: AccountPage });

/**
 * Identity and credentials ONLY (spec 2026-09-04 app-settings-page split the
 * preference-tier cards out to /preferences). Reached from the sidebar user
 * menu, not the nav rail. App behaviour lives on /preferences; instance-wide
 * concerns on /settings ("Server").
 */
function AccountPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Account" subtitle="Your profile and credentials" />
      <ProfileCard />
      {/* Self-service for ANY signed-in user (own passkeys only via the session). */}
      <PasskeysCard />
      <ChangePasswordCard />
    </main>
  );
}
