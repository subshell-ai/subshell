/**
 * The tray preference, and why it is not always offered.
 *
 * On Linux `TrayIconEvent` is never emitted and a stock GNOME has no
 * StatusNotifier host, so the icon can be silently invisible — a window hidden
 * to an icon that is not there is unreachable, with nothing to explain it. The
 * Rust side reports whether the switch is safe to show (`traySupported`) and
 * refuses to persist `true` where it is not; this component just does not
 * render. Three guards, all deliberate: do not collapse them to one.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { NodeSettings } from "@/lib/ipc";

export function PrefsCard(props: {
  settings: NodeSettings | undefined;
  busy: boolean;
  onCloseToTrayChange: (enabled: boolean) => void;
}) {
  const { settings, busy, onCloseToTrayChange } = props;
  if (settings?.traySupported !== true) return null;

  return (
    <Card>
      <CardContent className="flex items-center gap-2.5 p-4">
        <Switch
          id="close-to-tray"
          checked={settings.closeToTray}
          disabled={busy}
          onCheckedChange={onCloseToTrayChange}
        />
        <Label htmlFor="close-to-tray" className="cursor-pointer text-xs">
          Keep running in the menu bar when the window is closed
        </Label>
      </CardContent>
    </Card>
  );
}
