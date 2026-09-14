import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { InstanceNameCard } from "@/components/instance-name-card";
import { PageHeader } from "@/components/page-header";
import { ResetServerCard, resetCardVisible } from "@/components/settings/reset-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { apiFetch, errMessage } from "@/lib/api";
import { isDesktop } from "@/lib/desktop";

/** The two instance switches this page owns. */
type SettingKey = "allowRegistrations" | "allowNodeEnrollment";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

/**
 * The General page — instance-wide configuration, admins only (spec
 * 2026-09-02 settings-split). Per-user surface (password, notifications,
 * font, passkeys) lives on `/account`; self-service cards must never appear
 * here because the whole body is gated on the admin flag.
 *
 * It is the first page of the Server Settings group rather than the whole
 * admin surface (spec 2026-09-11 §4.1): API keys, the audit log, plugins and
 * status are pages the rail reaches directly, and the local-launch switch
 * moved to the `local` node's own page. What is left is the four things this
 * page is named for — the instance's name, registration, who may add nodes,
 * and the reset.
 */
function SettingsPage() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  /** Which switch last reported, and what it said — see `toggle`. */
  const [outcome, setOutcome] = useState<{ key: SettingKey; saved?: boolean; error?: string } | null>(null);

  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;

  const {
    data: settings,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiFetch<{ allowRegistrations: boolean; allowNodeEnrollment: boolean }>("/api/settings"),
    // Admin-only endpoint: without this gate a non-admin visiting /settings
    // (the page renders the "admins only" sentence for them) fired two
    // silent 403s per mount. Unknown ≠ open — fetch only once the server
    // says this viewer IS an admin.
    enabled: viewerIsAdmin === true,
  });

  /**
   * Flip one boolean setting.
   *
   * One function for both switches rather than a copy per setting: the error
   * handling below is the load-bearing part — without the catch a failed
   * PATCH was an unhandled rejection and the switch silently snapped back on
   * the next cache read, with no feedback at all — and that is exactly the
   * kind of thing a second copy quietly omits.
   */
  async function toggle(key: SettingKey, whatFailed: string) {
    if (!settings) return;
    setBusy(true);
    // Keyed by SETTING, not shared. Both switches wrote one `saved`/`error`
    // pair that only the Registration card rendered, so flipping the node
    // switch flashed "saved" beside the registration one and reported its
    // failures there too — under a control the person had not touched, and on
    // a narrow window possibly off screen. That is the same silent-feedback
    // failure the shared function exists to prevent, arriving by a different
    // door.
    setOutcome(null);
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: !settings[key] }),
      });
      setOutcome({ key, saved: true });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      setOutcome({ key, error: errMessage(err, whatFailed) });
    } finally {
      setBusy(false);
    }
  }

  /** This card's "saved" flash and refusal, or nothing when it was not this one. */
  function feedbackFor(key: SettingKey) {
    if (outcome?.key !== key) return null;
    return (
      <>
        {outcome.saved && <span className="text-detail text-success">saved</span>}
        {outcome.error && <p className="text-destructive text-sm">{outcome.error}</p>}
      </>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* No action slot: Status and Plugins were buttons here because the rail
          did not list them. The Server Settings group does now. */}
      <PageHeader title="General" subtitle="Instance name, registration, nodes, and reset (admins)" />
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
                  onCheckedChange={() => void toggle("allowRegistrations", "Couldn't change the registration setting.")}
                  disabled={busy || !settings}
                  aria-label="Allow new registrations"
                />
                <Label>{settings ? (settings.allowRegistrations ? "Open" : "Closed") : "Unknown"}</Label>
                {feedbackFor("allowRegistrations")}
              </div>
              {settingsError && (
                <ErrorBanner
                  message="Couldn't load instance settings."
                  className="rounded-md border"
                  action={
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-detail text-inherit underline"
                      onClick={() => void refetchSettings()}
                    >
                      Retry
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Nodes</CardTitle>
              <CardDescription>
                Let users add their own machines as nodes. Registering a node delegates command execution on it to this
                instance, so turning this off leaves adding them to admins.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-4">
                {/* Same "Unknown ≠ on" rule as the switch above: it claims a
                    state only once the server has reported one. */}
                <Switch
                  checked={settings?.allowNodeEnrollment ?? false}
                  onCheckedChange={() => void toggle("allowNodeEnrollment", "Couldn't change the node setting.")}
                  disabled={busy || !settings}
                  aria-label="Let users add their own nodes"
                />
                <Label>
                  {settings ? (settings.allowNodeEnrollment ? "Anyone signed in" : "Admins only") : "Unknown"}
                </Label>
                {feedbackFor("allowNodeEnrollment")}
              </div>
              {/* Said here rather than discovered later: turning this off is
                  "stop handing out new keys", and any key already minted stays
                  usable until it expires or is deleted. */}
              <p className="text-detail text-muted-foreground">
                Turning this off does not revoke setup keys that already exist — they expire after 24 hours, or can be
                deleted from the Nodes page.
              </p>
            </CardContent>
          </Card>

          {/* Danger zone, last (spec 2026-09-10 §6): admin AND the SERVER desktop
              shell only. The reset verb lives in that app's console, so an entry
              point anywhere else would be a button that lies. */}
          {resetCardVisible({ viewerIsAdmin, desktop: isDesktop() }) && <ResetServerCard />}
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
