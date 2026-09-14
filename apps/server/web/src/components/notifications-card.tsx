import { useEffect, useState } from "react";
import { PermissionNotice } from "@/components/desktop/permission-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDesktopPermissions } from "@/hooks/use-desktop-permissions";
import { errMessage } from "@/lib/api";
import { isServerDesktop } from "@/lib/desktop";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/notifications";
import type { Permission } from "@/types/permissions";

/**
 * Account → Notifications: per-device web-push opt-in (spec
 * 2026-08-30-harness-notifications). Deliberately dumb — every word shown
 * here is decided by the `PushState` that `@/lib/notifications` computed;
 * the card adds no judgement of its own. The three hooks are injectable
 * (defaulting to the real lib) so the state table is testable without
 * stubbing navigator/Notification globals.
 */

/** Helper lines the state union already implies, one per dead-end state. */
const STATE_HELP: Partial<Record<PushState, string>> = {
  blocked: "Allow notifications for subshell in your browser/OS settings.",
  unconfigured: "This instance cannot issue push keys (data directory not writable).",
  unsupported: "This browser does not support push notifications.",
};

/**
 * The desktop app reaches "unsupported" for a reason that is not a limitation:
 * it needs no push at all.
 *
 * Web push is a service worker plus VAPID, and no embedded webview ships a
 * `PushManager` — so the honest answer there is not "your browser cannot do
 * this" but "this app already does it another way". The shell notifies
 * natively off the SSE feed the app is already reading.
 */
const DESKTOP_HELP = "The desktop app notifies you natively, with no push subscription needed.";

/**
 * What macOS currently says, in words — the STANDING home for the recovery
 * (spec 2026-09-14 §5.4). The in-context notices are where someone reaches it
 * without looking; this is where they look.
 */
const PERMISSION_LINE: Record<Permission, string> = {
  authorized: "Allowed",
  provisional: "Allowed",
  denied: "Not allowed",
  "not-determined": "Not yet asked",
  unavailable: "Unavailable in this build",
};

/** iOS Safari only delivers web push from a home-screen-installed PWA. */
function isIOS(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent);
}

/** Props exist so tests can drive the state table without global stubs. */
export type NotificationsCardProps = {
  /** Defaults to the real `getPushState`. */
  getState?: () => Promise<PushState>;
  /** Defaults to the real `enablePush`. */
  enable?: () => Promise<PushState>;
  /** Defaults to the real `disablePush`. */
  disable?: () => Promise<PushState>;
};

/** Settings card for "notifications on this device". */
export function NotificationsCard({
  getState = getPushState,
  enable = enablePush,
  disable = disablePush,
}: NotificationsCardProps) {
  const { data: permissions } = useDesktopPermissions();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getState()
      .then((s) => live && setState(s))
      // A state probe that fails (offline, 500) is not a reason to show a
      // broken card — fall back to the actionable default.
      .catch(() => live && setState("off"));
    return () => {
      live = false;
    };
  }, [getState]);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      setState(state === "on" ? await disable() : await enable());
    } catch (err) {
      setError(errMessage(err, "The push setting could not be changed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          System notifications when a subshell needs your attention, enabled per device and browser and never pushed by
          the instance itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          {(state === "on" || state === "off") && (
            <Button onClick={() => void toggle()} disabled={busy}>
              {busy ? "Working…" : state === "on" ? "Disable on this device" : "Enable notifications on this device"}
            </Button>
          )}
          {state === null && <Button disabled>{busy ? "Working…" : "Checking…"}</Button>}
        </div>
        {/* role=status: the button can DISAPPEAR when a click lands in
            blocked/unconfigured — sighted users see the helper line appear,
            screen readers need it announced. */}
        {state && (isServerDesktop() && state === "unsupported" ? DESKTOP_HELP : STATE_HELP[state]) && (
          <p role="status" className="text-muted-foreground text-sm">
            {isServerDesktop() && state === "unsupported" ? DESKTOP_HELP : STATE_HELP[state]}
          </p>
        )}
        {/* The live half of the desktop branch. Only ever shown inside Subshell
            Server, where the query is enabled at all — in a browser the app's
            standing with macOS is not a fact about this device. */}
        {isServerDesktop() && permissions && (
          <div className="space-y-1.5">
            <p className="text-detail text-muted-foreground">
              macOS permission: {PERMISSION_LINE[permissions.notifications]}
            </p>
            {permissions.notifications === "denied" && (
              <PermissionNotice pane="notifications" message="Nothing will be shown until this is allowed again." />
            )}
            {/* Not asked yet is a state too: someone who pressed Continue on
                the first run without pressing Allow has no prompt until an
                agent next waits, and had no route back to the Allow button
                (review, 2026-09-14). The Fix raises the screen that has it. */}
            {permissions.notifications === "not-determined" && (
              <PermissionNotice pane="notifications" message="macOS has not been asked yet." />
            )}
          </div>
        )}
        {state === "unsupported" && isIOS() && (
          <p className="text-muted-foreground text-sm">
            On iOS, use Share → “Add to Home Screen” first. Notifications only arrive for the installed app.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
