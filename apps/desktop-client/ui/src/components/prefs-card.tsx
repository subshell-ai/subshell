/**
 * The tray preference, and why it is sometimes offered but not live.
 *
 * On Linux the tray icon is drawn only where a StatusNotifier host is
 * registered on the session bus: KDE has one, a stock GNOME needs the
 * AppIndicator extension, and where none is registered the icon is silently
 * invisible — so a window hidden into it is unreachable. The Rust side answers
 * that question with a real probe (`subshell_desktop_core::tray`) rather than
 * a platform check, and reports both halves: `traySupported` for whether the
 * switch is live, `trayStatus` for whether an absent tray is worth explaining.
 *
 * Three states, three renders:
 *
 * - `supported` — the switch works.
 * - `not-detected` — the switch is DISABLED, with the reason and a re-check.
 *   Deliberately not hidden: "no tray was detected, here is what to install"
 *   is actionable, an absent control is not, and installing the extension
 *   flips this without restarting the app.
 * - `unsupported` — no tray on this platform at all, so there is nothing to
 *   say and nothing to draw.
 *
 * The Rust side still refuses to persist `true` where no tray answered, and
 * still re-probes at the moment of hiding. This component is the explanation,
 * never the guard.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { NodeSettings } from "@/lib/ipc";

/**
 * Why the switch is disabled, in words that stay true for a user who can see
 * their own tray icon while reading them — the probe is a false negative on
 * the older XEmbed tray, so it says DETECTED, never "there is none".
 */
export const TRAY_NOT_DETECTED =
  "No system tray was detected on this desktop, so a hidden window would have nowhere to go. GNOME needs an " +
  "AppIndicator extension; KDE and most others have one already. Some older trays cannot be detected at all, so " +
  "an icon may still appear — install one, then check again.";

export function PrefsCard(props: {
  settings: NodeSettings | undefined;
  busy: boolean;
  /** True while the settings query is in flight, which is what the re-check runs. */
  rechecking: boolean;
  onCloseToTrayChange: (enabled: boolean) => void;
  onRecheckTray: () => void;
}) {
  const { settings, busy, rechecking, onCloseToTrayChange, onRecheckTray } = props;
  if (settings === undefined || settings.trayStatus === "unsupported") return null;
  const supported = settings.traySupported;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2.5">
          <Switch
            id="close-to-tray"
            checked={settings.closeToTray}
            disabled={busy || !supported}
            onCheckedChange={onCloseToTrayChange}
          />
          <Label htmlFor="close-to-tray" className="cursor-pointer text-xs">
            Keep running in the menu bar or system tray when the window is closed
          </Label>
        </div>
        {supported ? null : (
          <div className="flex items-start justify-between gap-4">
            <p className="text-muted-foreground text-xs">{TRAY_NOT_DETECTED}</p>
            <Button variant="outline" size="sm" disabled={busy || rechecking} onClick={onRecheckTray}>
              {rechecking ? "Checking…" : "Check again"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
