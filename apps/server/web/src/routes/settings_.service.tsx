import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { AddressesCard } from "@/components/service/addresses-card";
import { LocationsCard } from "@/components/service/locations-card";
import { ServerLogCard } from "@/components/service/server-log-card";
import { ServiceCard } from "@/components/service/service-card";
import { SupervisionCard } from "@/components/service/supervision-card";
import { UpdateCard } from "@/components/service/update-card";
import { Button } from "@/components/ui/button";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment, useSetServerAutostart } from "@/hooks/use-server-deployment";
import { useServerRestart } from "@/hooks/use-server-restart";

export const Route = createFileRoute("/settings_/service")({ component: ServicePage });

/**
 * Server Settings → Service: where this server listens, who supervises it,
 * where it writes, and what it logged (spec 2026-09-12 § 4.1).
 *
 * Called Service rather than Server because the control-plane host's own node
 * row is named "Server" by default, and because every card here is about the
 * running process rather than about the instance.
 *
 * The admin gate is the one `/settings/status` established: `viewerIsAdmin`
 * comes from the server and `undefined` counts as NOT admin, so a non-admin
 * mount fires no doomed 403 — and Refresh lives inside the admin branch,
 * because `refetch()` ignores the `enabled` flag and would fire exactly that.
 *
 * `useAdminStatus` is mounted here for two reasons at once: the Service card
 * names the boot time, and the restart waiter compares against the
 * `bootedAt` this query caches. Without it the waiter has no baseline and
 * would call the first answer a successful restart.
 */
function ServicePage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  const { data: view, error, isLoading, refetch } = useServerDeployment(isAdmin);
  const { data: status } = useAdminStatus(isAdmin);
  const restart = useServerRestart();
  const autostart = useSetServerAutostart();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title="Service"
        subtitle="Where this server listens, who supervises it, where it writes, and what it logged."
        action={
          isAdmin ? (
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Refresh
            </Button>
          ) : null
        }
      />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          {error && (
            <ErrorBanner
              message="Could not load this server's deployment."
              className="rounded-md border"
              action={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-inherit text-xs underline"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              }
            />
          )}
          {isLoading && !view && <p className="text-muted-foreground text-sm">Loading…</p>}
          {/* First, and outside the `view` branch: an update is worth
              offering even if the deployment read failed, and it renders
              nothing at all in a browser. */}
          <UpdateCard serverVersion={publicSettings?.serverVersion} />
          {view && (
            <>
              <ServiceCard view={view} restart={restart} bootedAt={status?.runtime.bootedAt} />
              <SupervisionCard view={view} autostart={autostart} />
              <AddressesCard view={view} restart={restart} />
              <LocationsCard view={view} />
              <ServerLogCard view={view} enabled={isAdmin} />
              {/* Stamped because the page polls: a figure that stopped
                  updating otherwise looks exactly like one that is simply not
                  changing. */}
              <p className="text-muted-foreground text-xs">
                Snapshot taken {new Date(view.generatedAt).toLocaleTimeString()} · refreshes every 15s
              </p>
            </>
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Service settings are for instance admins; your settings live under{" "}
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
