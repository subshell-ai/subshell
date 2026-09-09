import { createFileRoute, Link } from "@tanstack/react-router";
import { InventoryCard } from "@/components/admin-status/inventory-card";
import { RuntimeCard } from "@/components/admin-status/runtime-card";
import { SecurityCard } from "@/components/admin-status/security-card";
import { VersionsCard } from "@/components/admin-status/versions-card";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { usePublicSettings } from "@/hooks/use-public-settings";

export const Route = createFileRoute("/settings_/status")({ component: ServerStatusPage });

/**
 * The Server status page — one read of the whole instance, admins only.
 *
 * Read-only by design: /settings is where an admin CHANGES the instance, this
 * is where they see what it currently is. Nothing here is a control, which is
 * why the whole page can refresh under the viewer without a confirmation
 * anywhere.
 *
 * The admin gate is the same one /settings uses and for the same reason:
 * `viewerIsAdmin` comes from the server, and `undefined` (still loading) is
 * treated as NOT admin, so a non-admin never fires a doomed 403.
 */
function ServerStatusPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const { data: status, error, isLoading, refetch } = useAdminStatus(viewerIsAdmin === true);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title="Server status"
        subtitle="What this instance is running right now (admins)"
        // Refresh lives INSIDE the admin branch, not here. `refetch()` ignores
        // `enabled` (TanStack Query calls straight through to the fetcher), so
        // a Refresh button rendered for a non-admin would fire exactly the
        // doomed 403 the `enabled` gate exists to prevent — and render nothing,
        // because the error banner is inside that branch too.
        action={
          viewerIsAdmin === true ? (
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Refresh
            </Button>
          ) : null
        }
      />
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <>
          {error && (
            <ErrorBanner
              message="Could not load the instance status."
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
          {isLoading && !status && <p className="text-muted-foreground text-sm">Loading…</p>}
          {status && (
            <>
              <VersionsCard status={status} />
              <RuntimeCard status={status} />
              <InventoryCard status={status} />
              <SecurityCard status={status} />
              {/* Stamped because the page polls: without it, a figure that
                  stopped updating looks exactly like one that is simply not
                  changing. */}
              <p className="text-muted-foreground text-xs">
                Snapshot taken {new Date(status.generatedAt).toLocaleTimeString()} · refreshes every 15s
              </p>
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
