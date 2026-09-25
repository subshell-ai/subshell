import { Button } from "@internal/node-admin";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PendingExpiryCard } from "@/components/auth/pending-expiry-card";
import { ProviderDialog } from "@/components/auth/provider-dialog";
import { ProvidersTable } from "@/components/auth/providers-table";
import { ErrorBanner } from "@/components/error-banner";
import { PageHeader } from "@/components/page-header";
import { usePendingExpiry } from "@/hooks/use-admin-settings";
import { useAuthProviders } from "@/hooks/use-auth-providers";
import { usePublicSettings } from "@/hooks/use-public-settings";
import type { ProviderAdminView } from "@/types/auth-provider";

export const Route = createFileRoute("/settings_/auth")({ component: AuthPage });

/**
 * Settings → Auth: the admin-managed sign-in doors (spec 2026-09-24 §7).
 *
 * The gate is the one Status and Users use: server-derived `viewerIsAdmin`,
 * `undefined` (still loading) counting as NOT admin, and the providers query
 * `enabled` on it so a member's mount fires no doomed 403.
 *
 * What the page edits is the SET of doors and their half switches; the
 * General page keeps its registration toggle (Task 14 narrows it), and the
 * email row here is that same row seen from the door side: its toggles PATCH
 * through the same routes, and its null registration flag renders the gate's
 * computed answer, which public settings already carries — both fields come
 * from `registrationOpen()` server-side, so there is one truth and this page
 * reads it once.
 */
function AuthPage() {
  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;
  const isAdmin = viewerIsAdmin === true;
  const { data: providers, isLoading, error, refetch } = useAuthProviders(isAdmin);
  // The expiry field rides the shared admin settings read, gated the same
  // way as the providers query: a member's mount fires no doomed 403.
  const { data: settings } = usePendingExpiry(isAdmin);

  // null = the create dialog; a row = edit that row. One slot so both open
  // through the same component, keyed to the row inside it.
  const [dialog, setDialog] = useState<{ open: boolean; provider: ProviderAdminView | null }>({
    open: false,
    provider: null,
  });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <PageHeader
        title="Auth"
        subtitle="Which doors this instance signs people in through (admins)"
        action={
          isAdmin ? <Button onClick={() => setDialog({ open: true, provider: null })}>Add provider</Button> : undefined
        }
      />
      {viewerIsAdmin === undefined ? null : isAdmin ? (
        <>
          <div className="space-y-3">
            {error && (
              <ErrorBanner
                message="Couldn't load the providers."
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
            {!error &&
              (isLoading ? (
                <p className="text-detail text-muted-foreground">Loading the providers…</p>
              ) : (
                <ProvidersTable
                  providers={providers ?? []}
                  registrationComputedOpen={publicSettings?.allowRegistrations ?? false}
                  onEdit={(provider) => setDialog({ open: true, provider })}
                />
              ))}
          </div>
          {/* The pending-approval expiry window (spec 2026-09-24 §6): its own
              card under the door list, since it is the queue's policy rather
              than one door's switch. Rendered only when the server knows the
              field — an input for a number the route cannot back is worse
              than no card (the Lockdown card's render guard). */}
          {settings?.pendingApprovalExpiryDays !== undefined && (
            <PendingExpiryCard days={settings.pendingApprovalExpiryDays} />
          )}
          <ProviderDialog
            open={dialog.open}
            provider={dialog.provider}
            onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
            onSaved={() => {}}
          />
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Provider management is for instance admins; your own sign-in settings live under{" "}
          <Link to="/account" className="underline">
            Account settings
          </Link>
          .
        </p>
      )}
    </main>
  );
}
