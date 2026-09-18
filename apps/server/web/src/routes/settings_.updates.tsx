import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { UpdatesTable } from "@/components/updates/updates-table";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useCheckUpdates, useStartServerUpdate, useUpdates } from "@/hooks/use-updates";

export const Route = createFileRoute("/settings_/updates")({ component: UpdatesPage });

/**
 * Server Settings → Updates: what this instance is running, what it could be
 * running, and the one press per thing that changes it (spec 2026-09-15 §6).
 *
 * The admin gate is the one `/settings/status` established: `viewerIsAdmin`
 * comes from the server and `undefined` counts as NOT admin, so a non-admin
 * mount fires no doomed 403 — and the Retry lives inside the admin branch,
 * because `refetch()` ignores the `enabled` flag and would fire exactly that.
 *
 * **It does not poll while it sits there, and it does while an update runs.**
 * The release index has a 15-minute TTL on the server and nothing on this page
 * moves without a press, so a standing poll would buy nothing — but a running
 * job's phase is the one thing a person watches, so the cadence goes to 1 s
 * for exactly as long as one is in flight. Re-check is the control for the
 * other case: the page checked when it opened, and this is how you ask again.
 *
 * `useAdminStatus` is mounted here for the same reason `/settings/service`
 * mounts it: the update's restart waiter compares against the `bootedAt` that
 * query caches, and without a baseline it would call the first answer a
 * successful update.
 */
function UpdatesPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  const update = useStartServerUpdate();
  const busy = update.outcome === "running" || update.outcome === "waiting";
  const { data: view, error, isLoading, refetch } = useUpdates(isAdmin, busy ? 1_000 : false);
  useAdminStatus(isAdmin);
  const check = useCheckUpdates();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader title="Updates" subtitle="What this instance is running, and what it could be running." />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          {error && (
            <ErrorBanner
              message="Could not load what is available."
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
          {check.error && <ErrorBanner message={check.error} className="rounded-md border" />}
          {isLoading && !view && <p className="text-muted-foreground text-sm">Loading…</p>}
          {/* One Components table, rows ordered desktop first, Server second,
              Nodes LAST — an operator's call, 2026-09-17: the node rows are
              per-machine and grow with the fleet, so they belong below the
              rows that stay a screenful however many machines enroll. */}
          {view && <UpdatesTable view={view} update={update} onCheck={check.check} checking={check.pending} />}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Updates are for instance admins; your settings live under{" "}
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
