import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { InstanceNameCard } from "@/components/instance-name-card";
import { LocalLaunchCard } from "@/components/nodes/local-launch-card";
import { PageHeader } from "@/components/page-header";
import { SystemApiKeysCard } from "@/components/system-api-keys-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { apiFetch, errMessage } from "@/lib/api";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

/**
 * The Server page — instance-wide configuration, admins only (spec
 * 2026-09-02 settings-split). Per-user surface (password, notifications,
 * font, passkeys) lives on `/account`; self-service cards must never appear
 * here because the whole body is gated on the admin flag.
 */
function SettingsPage() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;

  const {
    data: settings,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiFetch<{ allowRegistrations: boolean }>("/api/settings"),
    // Admin-only endpoint: without this gate a non-admin visiting /settings
    // (the page renders the "admins only" sentence for them) fired two
    // silent 403s per mount. Unknown ≠ open — fetch only once the server
    // says this viewer IS an admin.
    enabled: viewerIsAdmin === true,
  });

  async function toggleRegistrations() {
    if (!settings) return;
    setBusy(true);
    setSaved(false);
    setRegError(null);
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ allowRegistrations: !settings.allowRegistrations }),
      });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      // Without this catch a failed PATCH was an unhandled rejection and the
      // switch silently snapped back on the next cache read — no feedback.
      setRegError(errMessage(err, "Couldn't change the registration setting."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <PageHeader
        title="Server"
        subtitle="Instance-wide configuration (admins)"
        action={
          // A Link WEARING the button style, not a Button wrapping a Link —
          // nesting two interactive elements is what `asChild` exists to avoid,
          // and this Button primitive has no `asChild`.
          <Link to="/settings/status" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Status
          </Link>
        }
      />
      {/* Gating mirrors the nav rule: these cards hit admin-only endpoints, so
          rendering them for a non-admin would only produce error banners. The
          server-side gates remain the actual enforcement either way. */}
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <>
          <InstanceNameCard />

          <Card>
            <CardHeader>
              <CardTitle>Registration</CardTitle>
              <CardDescription>Allow new users to register on this instance.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-4">
                {/* Unknown ≠ Open: the switch only claims a state the server
                    actually reported, and only moves once it has. */}
                <Switch
                  checked={settings?.allowRegistrations ?? false}
                  onCheckedChange={() => void toggleRegistrations()}
                  disabled={busy || !settings}
                  aria-label="Allow new registrations"
                />
                <Label>{settings ? (settings.allowRegistrations ? "Open" : "Closed") : "Unknown"}</Label>
                {saved && <span className="text-success text-xs">saved</span>}
              </div>
              {regError && <p className="text-destructive text-sm">{regError}</p>}
              {settingsError && (
                <ErrorBanner
                  message="Couldn't load instance settings."
                  className="rounded-md border"
                  action={
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-inherit text-xs underline"
                      onClick={() => void refetchSettings()}
                    >
                      Retry
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>

          <SystemApiKeysCard />
          {/* Gated on the server's canManage for `local` (owner/admin) — the card
              renders nothing for everyone else, spec 2026-08-31 §10. */}
          <LocalLaunchCard />
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Server settings are for instance admins — your settings live under{" "}
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
