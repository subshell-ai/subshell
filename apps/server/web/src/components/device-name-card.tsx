import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@internal/node-admin";
import { DEVICE_LABEL_MAX, normalizeDeviceLabel } from "@internal/subshell-protocol";
import { type JSX, useState } from "react";
import { deviceName, deviceNameFromUserAgent, setDeviceName } from "@/lib/device-name";

/**
 * Per-DEVICE name, shown to everyone else watching the same subshell.
 *
 * A subshell can be open on several devices at once and they all constrain
 * one pane, so the Devices list has to say which device is which — and the
 * User-Agent default cannot: two windows on the same machine both read
 * "Chrome on macOS", which makes the list, and the pin control beside it,
 * meaningless exactly when someone has two windows of different sizes open.
 *
 * Blank restores the derived name rather than storing an empty label.
 */
export function DeviceNameCard(): JSX.Element {
  // Lazy read: the choice is browser-local, so there is no in-flight state to
  // wait for (unlike the server-backed switches).
  const [value, setValue] = useState(() => deviceName());
  const [saved, setSaved] = useState(false);
  const derived = deviceNameFromUserAgent(navigator.userAgent ?? "");
  const cleaned = normalizeDeviceLabel(value);
  // The blank case is a real choice (restore the default), not an error.
  const willBe = cleaned || derived;

  function save(): void {
    setDeviceName(value);
    setValue(deviceName());
    setSaved(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>This device&apos;s name</CardTitle>
        <CardDescription>
          Shown to anyone else watching a subshell you have open, so they can tell which device is holding the
          terminal&apos;s size; two windows on one machine look identical until you name them. Defaults to your browser
          and platform, stored on this device only, and never sent anywhere but the subshells you attach to.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="device-name">Name</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="device-name"
            value={value}
            maxLength={DEVICE_LABEL_MAX}
            placeholder={derived}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            className="w-64"
          />
          <Button variant="outline" size="sm" onClick={save}>
            Save
          </Button>
          {saved && <span className="text-detail text-muted-foreground">Saved. New attachments use it</span>}
        </div>
        <p className="text-detail text-muted-foreground">
          {cleaned ? "Others will see" : "Blank restores the default, which is"} <span>{willBe}</span>
        </p>
      </CardContent>
    </Card>
  );
}
