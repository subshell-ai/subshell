import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch } from "@internal/node-admin";
import { useState } from "react";
import { resetSeenNotices, setTrustBannersEnabled, trustBannersEnabled } from "@/lib/trust-notice-prefs";

/**
 * Per-DEVICE switch for the trust banners — the amber strip that appears once
 * when you open a subshell running on someone else's node, or one that is
 * shared (`components/trust-notice-banner.tsx`).
 *
 * The card's job is as much to explain the icons as to hold the switch. Anyone
 * turning banners off should learn, at that moment, that the disclosure has
 * not gone anywhere: the header icon carries the same fact permanently and is
 * deliberately not switchable. A control that silences a security signal
 * without saying what remains is how people end up believing a shared pane is
 * private.
 *
 * Turning it back ON forgets every dismissal, so the switch means "start
 * reminding me" rather than "resume a set of decisions I can no longer see".
 */
export function TrustBannersCard() {
  // Lazy read: the choice is browser-local, so there is no in-flight state to
  // wait for (same shape as SwipeNavCard).
  const [on, setOn] = useState(() => trustBannersEnabled());

  function toggle() {
    const next = !on;
    if (next) resetSeenNotices();
    setOn(setTrustBannersEnabled(next));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sharing and node warnings</CardTitle>
        <CardDescription>
          Shows a one-time banner when you open a subshell that runs on a machine you don&apos;t own, or one that is
          shared with other people. Both mean someone else can read what the terminal shows. Turning this off hides the
          banner only: the amber icon in the subshell&apos;s header says the same thing, always, and hovering it
          explains why. Applies to this device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          <Switch checked={on} onCheckedChange={toggle} aria-label="Sharing and node warnings" />
          <Label>{on ? "On" : "Off"}</Label>
        </div>
      </CardContent>
    </Card>
  );
}
