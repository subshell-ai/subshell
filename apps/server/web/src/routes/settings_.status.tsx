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
  const { data: status, error, isLoading, refetch } = useAdminStatus(viewerIsAdmin === true);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Server status" subtitle="What this instance is running right now (admins)" />
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
