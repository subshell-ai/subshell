import { createFileRoute, Link } from "@tanstack/react-router";
import { InventoryCard } from "@/components/admin-status/inventory-card";
import { LocationsCard } from "@/components/admin-status/locations-card";
import { RuntimeCard } from "@/components/admin-status/runtime-card";
import { SecurityCard } from "@/components/admin-status/security-card";
import { VersionsCard } from "@/components/admin-status/versions-card";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { DevProxyNotice } from "@/components/service/dev-proxy-notice";
import { Button } from "@/components/ui/button";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment } from "@/hooks/use-server-deployment";

export const Route = createFileRoute("/settings_/status")({ component: ServerStatusPage });

/**
 * The Server status page — one read of the whole instance, admins only.
 *
 * Read-only by design: /settings is where an admin CHANGES the instance, this
 * is where they see what it currently is. Nothing here is a control, which is
 * why the whole page can refresh under the viewer without a confirmation
 * anywhere.
 *
 * The page reads TWO routes. `GET /api/admin/status` is the instance itself;
 * `GET /api/admin/server` is the deployment view, mounted here since spec
 * 2026-09-14 because the Locations card's paths (config file, service
 * definition, manager log) live only there and duplicating them into
 * `admin/status` would be two routes to keep agreeing for one card. They can
 * fail independently, so each has its own error banner and neither one's
 * failure hides the other's cards.
 *
 * The admin gate is the same one /settings uses and for the same reason:
 * `viewerIsAdmin` comes from the server, and `undefined` (still loading) is
 * treated as NOT admin, so a non-admin never fires a doomed 403.
 *
 * **No Refresh button and no snapshot stamp**, matching `/settings/service`:
 * the page polls, so a control offering to do what it already does reads as a
 * page that does not — and a timestamp exists only to prove the poll is
 * alive, which is a promise worth not making. Retry stays and stays INSIDE
 * the admin branch, because `refetch()` ignores `enabled` (TanStack Query
 * calls straight through to the fetcher) and a refetching control rendered
 * for a non-admin would fire exactly the doomed 403 the gate exists to
 * prevent — and render nothing, the error banner being inside that branch too.
 */
function ServerStatusPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  const { data: status, error, isLoading, refetch } = useAdminStatus(isAdmin);
  const {
    data: view,
    error: deploymentError,
    isLoading: deploymentLoading,
    refetch: refetchDeployment,
  } = useServerDeployment(isAdmin);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Server status" subtitle="What this instance is running right now (admins)" />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          {error && (
            <ErrorBanner
              message="Could not load the instance status."
              className="rounded-md border"
              action={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-detail text-inherit underline"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              }
            />
          )}
          {deploymentError && (
            <ErrorBanner
              message="Could not load this server's deployment."
              className="rounded-md border"
              action={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-detail text-inherit underline"
                  onClick={() => void refetchDeployment()}
                >
                  Retry
                </Button>
              }
            />
          )}
          {((isLoading && !status) || (deploymentLoading && !view)) && (
            <p className="text-muted-foreground text-sm">Loading…</p>
          )}
          {status && (
            <>
              <DevProxyNotice />
              <VersionsCard status={status} />
              <RuntimeCard status={status} />
            </>
          )}
          {/* Outside the `status` branch on purpose: the two reads fail
              independently, so a failed instance read must not take the
              paths off the page as well. */}
          {view && <LocationsCard view={view} />}
          {status && (
            <>
              <InventoryCard status={status} />
              <SecurityCard status={status} />
            </>
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Server status is for instance admins; your settings live under{" "}
          <Link to="/preferences" className="underline">
            Preferences
          </Link>{" "}
          and{" "}
          <Link to="/account" className="underline">
            Account settings
          </Link>
          .
        </p>
      )}
    </main>
  );
}
