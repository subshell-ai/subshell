import { Button } from "@internal/node-admin";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { DevProxyNotice } from "@/components/service/dev-proxy-notice";
import { ServiceCard } from "@/components/service/service-card";
import { SupervisionCard } from "@/components/service/supervision-card";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment, useSetServerAutostart } from "@/hooks/use-server-deployment";
import { useServerRestart } from "@/hooks/use-server-restart";
import { useSetSupervision } from "@/hooks/use-set-supervision";

export const Route = createFileRoute("/settings_/service")({ component: ServicePage });

/**
 * Server Settings → Service: who supervises this server (spec 2026-09-12
 * § 4.1; the Locations card moved to `/settings/status` in spec 2026-09-14,
 * where the read-only facts live; the Addresses card to `/settings/networking`
 * on 2026-09-17, where the question it answers — how this server is reached —
 * is the page's whole subject; and the server's own log tail to the System tab
 * of `/settings/logs` on 2026-09-20, beside the audit trail it is read
 * next to — "what did it do" and "what happened to it" are one errand).
 *
 * Called Service rather than Server because the control-plane host's own node
 * row is named "Server" by default, and because every card here is about the
 * running process rather than about the instance.
 *
 * The admin gate is the one `/settings/status` established: `viewerIsAdmin`
 * comes from the server and `undefined` counts as NOT admin, so a non-admin
 * mount fires no doomed 403 — and the error banner's Retry lives inside the
 * admin branch, because `refetch()` ignores the `enabled` flag and would fire
 * exactly that.
 *
 * **There is no Refresh button and no snapshot stamp**, matching
 * `/settings/status`. The page polls, so a control offering to do what it
 * already does every few seconds reads as a page that does not — and a
 * timestamp exists only to prove a poll is alive, which is a promise worth
 * not making. Retry stays, because it answers the one case the interval
 * cannot: the fetch failed.
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
  const supervision = useSetSupervision();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Service" subtitle="Who supervises this server." />
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
                  className="h-auto p-0 text-detail text-inherit underline"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              }
            />
          )}
          {isLoading && !view && <p className="text-muted-foreground text-sm">Loading…</p>}
          {/* The bundled-server offer that used to lead this page is on
              `/settings/updates` now (spec 2026-09-15 §6), folded into the
              Server row of the Components table there: "this app ships a
              newer server" and "the release source has a newer server" are
              two answers to one question, and on two pages a person had to
              choose which to believe. */}
          {view && (
            <>
              <DevProxyNotice />
              <ServiceCard view={view} restart={restart} bootedAt={status?.runtime.bootedAt} />
              <SupervisionCard view={view} autostart={autostart} supervision={supervision} />
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
