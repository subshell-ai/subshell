import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errMessage } from "@/lib/api";
import { getMasterSwitch, setMasterSwitch } from "@/lib/notifications";

/**
 * Account → Notifications: the account-wide master switch (spec
 * 2026-08-31). One value shared across every device, stored in `user_meta`;
 * off means NO subshell push is ever sent to this user, whatever the per-device
 * opt-ins or per-subshell bells say. It complements (does not replace) the
 * per-device {@link NotificationsCard}. The two hooks are injectable so the
 * read/write cycle is testable without stubbing fetch.
 */

/** Props exist so tests can drive the switch without a live server. */
export type NotificationsMasterCardProps = {
  /** Defaults to the real `getMasterSwitch`. */
  getEnabled?: () => Promise<boolean>;
  /** Defaults to the real `setMasterSwitch`. */
  setEnabled?: (on: boolean) => Promise<boolean>;
};

/** Settings card for "receive subshell notifications at all". */
export function NotificationsMasterCard({
  getEnabled = getMasterSwitch,
  setEnabled = setMasterSwitch,
}: NotificationsMasterCardProps) {
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getEnabled()
      .then((on) => live && setEnabledState(on))
      // A probe that fails (offline, 500) must not leave a broken switch:
      // fall back to on (the documented default) rather than a false "off".
      .catch(() => live && setEnabledState(true));
    return () => {
      live = false;
    };
  }, [getEnabled]);

  async function toggle() {
    if (enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setError(null);
    // Optimistic: move the switch now, roll back only if the write fails. The
    // server echoes the persisted value, so on success we adopt that.
    setEnabledState(next);
    try {
      setEnabledState(await setEnabled(next));
    } catch (err) {
      setEnabledState(enabled);
      setError(errMessage(err, "The notification setting could not be changed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subshell notifications</CardTitle>
        <CardDescription>
          Receive notifications when a subshell needs your attention. This is your account-wide switch — turning it off
          silences every device at once, regardless of the per-subshell or per-device settings below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          {/* Unknown ≠ On: the switch only claims a state the server reported,
              and is inert until it has. */}
          <Switch
            checked={enabled ?? false}
            onCheckedChange={() => void toggle()}
            disabled={busy || enabled === null}
            aria-label="Receive subshell notifications"
          />
          <Label>{enabled === null ? "Unknown" : enabled ? "On" : "Off"}</Label>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
