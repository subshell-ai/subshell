import { type JSX, useState } from "react";
import { AddressQr } from "@/components/address-qr";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { type InstallPlatform, installPlatformFor } from "@/lib/mobile-install";

/**
 * How to put Subshell on a phone — the address to open, and the gesture that
 * turns it into an app.
 *
 * Both halves are load-bearing and the address is the harder one. The SPA has
 * been an installable PWA since the mobile work, but nothing on any surface
 * said so, and the person who most needs it is reading this at a desk: the
 * address their browser is on is very often `localhost`, which their phone
 * cannot reach. So the dialog offers every origin this instance will accept a
 * sign-in from and encodes the chosen one as a QR, rather than asking someone
 * to type a tailnet hostname on a phone keyboard.
 *
 * Not admin-gated, and it asks for nothing: the addresses ride the
 * public-settings payload every signed-in page already holds.
 */

/** One platform's steps. The tab group is three GESTURES, not three brands —
 * which is why macOS Safari sits under "Browser" beside Chrome rather than
 * under the Apple tab with the iPhone. */
const STEPS: Record<InstallPlatform, { label: string; steps: string[] }> = {
  browser: {
    label: "Browser",
    steps: [
      "Open the address above in Chrome or Edge.",
      "Click the install icon at the right of the address bar, or ⋮ → Cast, save and share → Install page as app.",
      "On Safari for macOS it is File → Add to Dock instead.",
    ],
  },
  apple: {
    label: "iPhone & iPad",
    steps: [
      "Open the address above in Safari. Chrome and Firefox on iOS cannot install it — only Safari can.",
      "Tap the Share button, then Add to Home Screen.",
      "Tap Add, then open Subshell from its new icon. Notifications only ever arrive for the installed app.",
    ],
  },
  android: {
    label: "Android",
    steps: [
      "Open the address above in Chrome.",
      "Tap ⋮ → Add to Home screen, then Install app.",
      "Open Subshell from its new icon.",
    ],
  },
};

const PLATFORM_OPTIONS = (Object.keys(STEPS) as InstallPlatform[]).map((value) => ({
  value,
  label: STEPS[value].label,
}));

export function MobileInstallDialog({
  open,
  onOpenChange,
  origin = typeof window === "undefined" ? "" : window.location.origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The address THIS browser reached the plane on. A parameter so tests can
   * drive the picker without a stubbed `window.location`. */
  origin?: string;
}): JSX.Element {
  // The guess is the tab, never the only tab: someone at a desktop looking up
  // what their phone should do is a normal reason to be here.
  const [platform, setPlatform] = useState<InstallPlatform>(() => installPlatformFor());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Subshell for Mobile</DialogTitle>
          <DialogDescription>
            Subshell installs on a phone as an app — full screen, its own icon, and the only place notifications arrive.
          </DialogDescription>
        </DialogHeader>

        <AddressQr active={open} origin={origin} />

        <div className="space-y-2">
          <Segmented
            ariaLabel="Where you are installing Subshell"
            options={PLATFORM_OPTIONS}
            value={platform}
            onChange={setPlatform}
            className="w-full"
          />
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
            {STEPS[platform].steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  );
}
