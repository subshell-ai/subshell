import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { HarnessRow } from "@/components/harness-row";
import { LocalLaunchCard } from "@/components/nodes/local-launch-card";
import { NotificationsCard } from "@/components/notifications-card";
import { NotificationsMasterCard } from "@/components/notifications-master-card";
import { PageHeader } from "@/components/page-header";
import { PasskeysCard } from "@/components/passkeys-card";
import { SystemApiKeysCard } from "@/components/system-api-keys-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useHarnessToggles } from "@/hooks/use-harness-toggles";
import { useHarnesses, useRecheckHarnesses } from "@/hooks/use-harnesses";
import { apiFetch, errMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  // Change-password form state.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    setPwSaved(false);
    try {
      // better-auth's own change-password route (session cookie auth), via
      // the shared client. The destructured local is renamed because the
      // component's own error state already owns the `pwError` name.
      const { error: changeErr } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (changeErr) {
        const details = (changeErr as unknown as { body?: { details?: unknown[] } }).body?.details;
        const detail = Array.isArray(details) && details.length > 0 ? String(details[0]) : null;
        setPwError(detail ?? "Password change failed — is the current password correct?");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwSaved(true);
    } catch {
      setPwError("Network error");
    } finally {
      setPwBusy(false);
    }
  }

  const {
    data: settings,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiFetch<{ allowRegistrations: boolean }>("/api/settings"),
  });

  const { data: harnesses, isLoading: harnessesLoading, isError: harnessesError } = useHarnesses();
  const recheck = useRecheckHarnesses();
  const { toggle: toggleHarness, errors: harnessErrors, pending: togglePending } = useHarnessToggles();

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
      <PageHeader title="Settings" subtitle="Admin-only configuration" />

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

      {/* Account-wide switch first: it gates every device, so it reads as the
          parent of the per-device opt-in below it. */}
      <NotificationsMasterCard />
      <NotificationsCard />

      <SystemApiKeysCard />
      {/* Gated on the server's canManage for `local` (owner/admin) — the card
          renders nothing for everyone else, spec 2026-08-31 §10. */}
      <LocalLaunchCard />
      {/* Self-service for ANY signed-in user (own passkeys only via the
          session), hence above the admin-scoped cards' concerns. */}
      <PasskeysCard />

      <Card>
        <CardHeader>
          <CardTitle>Harness plugins</CardTitle>
          <CardDescription>
            Agent harnesses on this machine. Enabling re-checks that the CLI is installed; disabling hides its profiles
            and blocks new sessions (running sessions keep going).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {harnessesLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {harnessesError && (
            <ErrorBanner
              message="Couldn't load harnesses."
              className="rounded-md border"
              action={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-inherit text-xs underline"
                  onClick={() => void recheck()}
                >
                  Retry
                </Button>
              }
            />
          )}
          {harnesses?.map((h) => (
            <HarnessRow
              key={h.id}
              harness={h}
              pending={togglePending}
              error={harnessErrors[h.id]}
              onToggle={toggleHarness}
              onRecheck={recheck}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Update the password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            {pwError && <p className="text-destructive text-sm">{pwError}</p>}
            {pwSaved && <p className="text-success text-xs">Password updated</p>}
            <Button type="submit" disabled={pwBusy}>
              {pwBusy ? "Updating…" : "Update password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
