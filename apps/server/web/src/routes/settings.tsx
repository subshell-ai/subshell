import {
  apiFetch,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  errMessage,
  Label,
  Switch,
} from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { InstanceNameCard } from "@/components/instance-name-card";
import { PageHeader } from "@/components/page-header";
import { LockdownCard } from "@/components/settings/lockdown-card";
import { ResetServerCard, resetCardVisible } from "@/components/settings/reset-card";
import { SetupChecklistCard } from "@/components/settings/setup-checklist-card";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { isServerDesktop } from "@/lib/desktop";
import { SETTINGS_QUERY_KEY } from "@/lib/query-keys";

/**
 * The two instance switches this page owns. Registration is NOT one of them:
 * it lives per door on Settings → Auth now (spec 2026-09-24 §5).
 */
type SettingKey = "allowNodeEnrollment" | "allowServerSubshells";

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
 * moved to the `local` node's own page. What is left is the five things this
 * page is named for — the instance's name, who may add nodes, whether the
 * Server is itself a place subshells run, the lockdown, and the reset.
 * Registration moved to Settings → Auth, where each door carries its own
 * switch (spec 2026-09-24 §5).
 */
function SettingsPage() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  /** The last switch that FAILED, and what it said — see `toggle`. A success
   *  is recorded nowhere: the switch itself is the confirmation (operator ask
   *  2026-09-24), so a boolean setting has nothing to report back but a refusal. */
  const [outcome, setOutcome] = useState<{ key: SettingKey; error: string } | null>(null);

  const { data: publicSettings } = usePublicSettings();
  const viewerIsAdmin = publicSettings?.viewerIsAdmin;

  const {
    data: settings,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () =>
      apiFetch<{
        allowNodeEnrollment: boolean;
        allowServerSubshells: boolean;
        // Required in the CURRENT route's schema, so the type says required —
        // but a binary older than a field omits it from its GET, and a cached
        // PWA can outlive its server, so each switch below reads its absent
        // value with THAT field's server-side default: both `?? true` (open
        // by default). Reading one as closed by default would make this card
        // contradict the pages that act on the same setting.
        lockdown?: boolean;
        localNodeName?: string;
        // Both optional for the usual absent-field reason: a server older than
        // lockdown answers without either, and the card must NOT render an
        // ask whose machine name it does not know (the switch would type into
        // nothing).
      }>("/api/settings"),
    // Admin-only endpoint: without this gate a non-admin visiting /settings
    // (the page renders the "admins only" sentence for them) fired two
    // silent 403s per mount. Unknown ≠ open — fetch only once the server
    // says this viewer IS an admin.
    enabled: viewerIsAdmin === true,
  });

  /**
   * Flip one boolean setting.
   *
   * One function for every switch here rather than a copy per setting: the error
   * handling below is the load-bearing part — without the catch a failed
   * PATCH was an unhandled rejection and the switch silently snapped back on
   * the next cache read, with no feedback at all — and that is exactly the
   * kind of thing a second copy quietly omits.
   */
  async function toggle(key: SettingKey, whatFailed: string) {
    if (!settings) return;
    setBusy(true);
    // Keyed by SETTING, not shared. The switches once wrote one `saved`/`error`
    // pair that only the Registration card rendered, so flipping the node
    // switch flashed "saved" beside the registration one and reported its
    // failures there too — under a control the person had not touched, and on
    // a narrow window possibly off screen. That is the same silent-feedback
    // failure the shared function exists to prevent, arriving by a different
    // door. The success half is now gone entirely (a moved switch reports
    // itself); the keying stays because a REFUSAL must still appear beside the
    // switch that earned it.
    setOutcome(null);
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: !settings[key] }),
      });
      // No success marker: this read is what moves the switch.
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    } catch (err) {
      setOutcome({ key, error: errMessage(err, whatFailed) });
    } finally {
      setBusy(false);
    }
  }

  /** This switch's refusal, or nothing when it was not the one that failed. */
  function feedbackFor(key: SettingKey) {
    if (outcome?.key !== key) return null;
    return <p className="text-destructive text-detail">{outcome.error}</p>;
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* No action slot: Status and Plugins were buttons here because the rail
          did not list them. The Server Settings group does now. */}
      <PageHeader title="General" subtitle="Instance name, nodes, and reset (admins)" />
      {/* Gating mirrors the nav rule: these cards hit admin-only endpoints, so
          rendering them for a non-admin would only produce error banners. The
          server-side gates remain the actual enforcement either way. */}
      {viewerIsAdmin === undefined ? null : viewerIsAdmin ? (
        <>
          {/* FIRST, above everything this page is named for, and absent
              entirely once there is nothing left to do (spec 2026-09-15
              § 5.2). A headless operator arrives here with a running server
              and no idea what is still missing; the cards below are all
              things to CHANGE, and this is the one that says what needs
              changing. It renders nothing on a finished instance, so the
              page it heads is unchanged for everyone else. */}
          <SetupChecklistCard />

          <InstanceNameCard />

          {/* Registration left this page with the OIDC work (spec
              2026-09-24 §5): the answer lives on each door now, and Settings →
              Auth carries one switch per provider. The load-failure banner
              came along to the card that still reads these settings. */}
          <Card>
            <CardHeader>
              <CardTitle>Nodes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-4">
                {/* Unknown ≠ Open: the switch only claims a state the server
                    actually reported, and only moves once it has. And the same
                    UNKNOWN rule as the Server switch below: this setting's
                    absent-row default is OPEN (`repo.get(KEY, true)`
                    server-side), so an absent field reads as "anyone can add" —
                    reading it as admins-only would have this card contradict
                    `lib/node-enrollment.ts` (which reads unknown as allowed and
                    draws the live button) and the route (which admits every
                    signed-in user) about one setting, two pages apart. */}
                <Switch
                  checked={settings?.allowNodeEnrollment ?? true}
                  onCheckedChange={() => void toggle("allowNodeEnrollment", "Couldn't change the node setting.")}
                  disabled={busy || !settings}
                  aria-label="Let users add their own nodes"
                />
                <Label>
                  {settings
                    ? (settings.allowNodeEnrollment ?? true)
                      ? "Anyone signed in can add nodes"
                      : "Only admins can add nodes"
                    : "Unknown"}
                </Label>
                {feedbackFor("allowNodeEnrollment")}
              </div>
              {/* Said here rather than discovered later: turning this off is
                  "stop handing out new keys", and any key already minted stays
                  usable until it expires or is deleted. */}
              <p className="text-detail text-muted-foreground">
                Turning this off does not revoke setup keys that already exist. They expire after 24 hours, or can be
                deleted from the Nodes page.
              </p>
              {/* The second Nodes decision: WHO may add machines, and whether
                  the Server is one of the machines subshells run on
                  (operator ask 2026-09-24). Same switch idiom and per-key
                  feedback — but its UNKNOWN reads ON, not off: the setting's
                  absent-row default is on, so a server older than the field
                  (which strips it from PATCHes and omits it from GETs) is
                  faithfully described as running. Reading absent as off
                  would show this card refusing to move while the machine
                  does exactly what its switch does not claim. */}
              <div className="flex items-center gap-4">
                <Switch
                  checked={settings?.allowServerSubshells ?? true}
                  onCheckedChange={() => void toggle("allowServerSubshells", "Couldn't change the server setting.")}
                  disabled={busy || !settings}
                  aria-label="Run subshells on the server"
                />
                <Label>
                  {settings
                    ? (settings.allowServerSubshells ?? true)
                      ? "The server and nodes can run subshells"
                      : "Only nodes can run subshells"
                    : "Unknown"}
                </Label>
                {feedbackFor("allowServerSubshells")}
              </div>
              <p className="text-detail text-muted-foreground">
                Turning this off means you can only start subshells from nodes, not from the server itself. Subshells
                already running finish on their own.
              </p>
              {/* The settings read failed: this card is the page's only reader
                  of that query now, so the banner lives here (it lived in the
                  Registration card until that moved to Settings → Auth). */}
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

          {/* Lockdown (operator ask 2026-09-24): the instance-wide stop lives
              with the settings rather than the reset because it IS reversible
              from here, and it renders on every admin browser, headless
              included — unlike the reset below, it never leaves the server
              unreachable. Rendered only when the server knows the field: an
              ask that cannot name the machine to type is worse than no card. */}
          {settings && settings.lockdown !== undefined && settings.localNodeName !== undefined && (
            <LockdownCard lockdown={settings.lockdown} machineName={settings.localNodeName} />
          )}

          {/* Danger zone, last (spec 2026-09-10 §6): admin AND the SERVER desktop
              shell only. The reset verb lives in that app's console, so an entry
              point anywhere else would be a button that lies. */}
          {resetCardVisible({ viewerIsAdmin, desktop: isServerDesktop() }) && <ResetServerCard />}
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
