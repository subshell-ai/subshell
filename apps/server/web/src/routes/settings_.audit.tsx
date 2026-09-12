import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { AuditTrailCard } from "@/components/settings/audit-trail-card";
import { usePublicSettings } from "@/hooks/use-public-settings";

export const Route = createFileRoute("/settings_/audit")({ component: AuditLogPage });

/**
 * The audit log page (spec 2026-09-11 §4.4) — the trail that used to sit under
 * the roster on `/users`, now a page with a name of its own.
 *
 * Read-only, like `/settings/status`: nothing here changes the instance. The
 * admin gate is the one `/settings` uses — server-derived `viewerIsAdmin`,
 * with `undefined` (still loading) counting as NOT admin — so a non-admin
 * mount never fires the doomed 403 the card's query would otherwise make.
 */
function AuditLogPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* Deliberately NOT the card's own description reworded: the two sit a
          few pixels apart, so one sentence twice reads as a rendering bug —
          and a duplicated string makes every test locator ambiguous between
          the header and the gated card (e2e's member check caught exactly
          that). The header says WHOSE page this is; the card says what the
          table holds. */}
      <PageHeader title="Audit log" subtitle="A read-only record of what happened on this instance (admins)" />
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <AuditTrailCard />
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
