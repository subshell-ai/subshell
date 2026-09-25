import { Button } from "@internal/node-admin";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { AuditTrailCard } from "@/components/settings/audit-trail-card";
import { ServerLogCard } from "@/components/settings/server-log-card";
import { Segmented } from "@/components/ui/segmented";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useServerDeployment } from "@/hooks/use-server-deployment";

/** The page's two halves, keyed in the URL. Order is the tabs' order. */
const LOGS_TABS = [
  { value: "system", label: "System log" },
  { value: "audit", label: "Audit log" },
] as const;

type LogsTab = (typeof LOGS_TABS)[number]["value"];

export const Route = createFileRoute("/settings_/logs")({
  component: LogsPage,
  // ABSENCE is the default: only `?tab=audit` rides the URL, so the plain
  // path is the System tab's address rather than one spelling of it plus a
  // redundant `?tab=system` — the same reason login.tsx omits an empty
  // `redirect`. Any other value reads as the default, never as an error.
  validateSearch: (search: Record<string, unknown>): { tab?: "audit" } =>
    search.tab === "audit" ? { tab: "audit" } : {},
});

/**
 * Server Settings → Logs: the two read-only views of this server, as tabs
 * (operator's ask, 2026-09-20). The audit trail moved here from its own
 * `/settings/audit` page — a page whose whole body was one table is a tab —
 * and the server's own log tail moved here from Service, because the two
 * sentences a person is here for are "what did the server do" and "what
 * happened to it", read together.
 *
 * The tab is URL state, not component state, so a link or a back button
 * lands on the half it names; `/settings/logs?tab=audit` is a shareable
 * address for the trail.
 *
 * The admin gate is the one `/settings/status` established: server-derived
 * `viewerIsAdmin`, with `undefined` (still loading) counting as NOT admin, so
 * a non-admin mount fires no doomed 403 — and Retry on the System half stays
 * inside the admin branch, because `refetch()` ignores the `enabled` flag.
 *
 * The System half mounts `useServerDeployment` itself, since the log card's
 * debug switch reads the deployment view's `logging.source` — at the Status
 * page's 60 s, not Service's 5 s: the paths and the logging source move only
 * when a page acts on them, and that write lands in this same cache.
 * The read is further gated on the ACTIVE tab, because every poll of that
 * route is a `Bun.spawnSync` stall for the whole server (see
 * `apps/server/web/AGENTS.md`) and an operator reading the audit trail should
 * not be paying for it.
 */
function LogsPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  const { tab } = Route.useSearch();
  const active: LogsTab = tab ?? "system";
  const navigate = Route.useNavigate();
  const { data: view, error, isLoading, refetch } = useServerDeployment(isAdmin && active === "system", 60_000);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* Deliberately not either card's own description reworded — the old
          audit page's comment kept that rule for a duplicated-string reason
          (header text made every e2e locator ambiguous), and it travels. */}
      <PageHeader title="Logs" subtitle="What this server logged, and what was done to it" />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          <Segmented
            ariaLabel="Which log"
            // Content-sized tab strip, like the Users page (2026-09-25).
            fill={false}
            options={[...LOGS_TABS]}
            value={active}
            onChange={(next) => void navigate({ search: next === "audit" ? { tab: "audit" } : {} })}
          />
          {active === "system" ? (
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
              {view && <ServerLogCard view={view} enabled />}
            </>
          ) : (
            <AuditTrailCard />
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Instance settings are for admins. Your settings live under{" "}
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
