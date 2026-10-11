import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch } from "@internal/node-admin";
import { useState } from "react";
import { setSwipeNavEnabled, swipeNavEnabled } from "@/lib/swipe-nav-pref";

/**
 * Per-DEVICE switch for walking the subshell list with a thumb-swipe on
 * `/subshells/$id` (spec 2026-09-04 swipe-nav; storage in lib/swipe-nav-pref,
 * on by default). The escape hatch for anyone whose horizontal drag belongs
 * to xterm alone — vertical scrollback and long-press selection are
 * untouched either way.
 */
export function SwipeNavCard() {
  // Lazy read: the choice is browser-local, so there is no in-flight state
  // to wait for (unlike the server-backed switches).
  const [on, setOn] = useState(() => swipeNavEnabled());

  function toggle() {
    setOn(setSwipeNavEnabled(!on));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Swipe between subshells</CardTitle>
        <CardDescription>
          Swipe left or right across a terminal on this phone to switch subshells in sidebar order. This setting applies
          only to this device; you can still scroll vertically and long-press to select text.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          <Switch checked={on} onCheckedChange={toggle} aria-label="Swipe between subshells" />
          <Label>{on ? "On" : "Off"}</Label>
        </div>
      </CardContent>
    </Card>
  );
}
