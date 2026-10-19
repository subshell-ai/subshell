import { Card, CardContent, CardHeader, CardTitle } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/components/dashboard-page";
import { MOBILE_INSTALL_STEPS, MobileInstallContent } from "@/components/mobile-install-content";
import { PageHeader } from "@/components/page-header";
import { type InstallPlatform, installPlatformFor } from "@/lib/mobile-install";

export const Route = createFileRoute("/mobile")({
  validateSearch: (search: Record<string, unknown>): { platform: InstallPlatform } => ({
    platform:
      search.platform === "apple" || search.platform === "android" || search.platform === "browser"
        ? search.platform
        : installPlatformFor(),
  }),
  component: MobilePage,
});

function MobilePage() {
  const { platform } = Route.useSearch();
  return (
    <DashboardPage>
      <PageHeader title="Subshell for Mobile" subtitle="Install Subshell on your phone or in your browser." />
      <Card>
        <CardHeader>
          <CardTitle>{MOBILE_INSTALL_STEPS[platform].label}</CardTitle>
        </CardHeader>
        <CardContent>
          <MobileInstallContent platform={platform} />
        </CardContent>
      </Card>
    </DashboardPage>
  );
}
