import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch } from "@internal/node-admin";
import { useBooleanSetting } from "@/hooks/use-boolean-setting";
import { getMasterSwitch, setMasterSwitch } from "@/lib/notifications";

/**
 * Account → Notifications: the account-wide master switch (spec
 * 2026-08-31). One value shared across every device, stored in `user_meta`;
 * off means NO subshell push is ever sent to this user, whatever the per-device
 * opt-ins or per-subshell bells say. It complements (does not replace) the
 * per-device {@link NotificationsCard}. The two endpoints are injectable so
 * the read/write cycle is testable without stubbing fetch, and the state
 * machine is {@link useBooleanSetting}, shared with the MCP account card.
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
  const { enabled, busy, error, toggle } = useBooleanSetting({
    get: getEnabled,
    set: setEnabled,
    errorMessage: "The notification setting could not be changed.",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subshell notifications</CardTitle>
        <CardDescription>
          Receive notifications when a subshell needs your attention. Turning this off silences all your devices, even
          if notifications are enabled for individual subshells or devices.
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
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
